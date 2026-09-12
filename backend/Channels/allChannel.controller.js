const { message } = require("../addons/utils/shippingRulesValidation");
const AllChannel = require("./allChannel.model"); // Adjust path if necessary
const axios = require("axios");
const crypto = require("crypto");
const express = require("express");
const app = express();
app.use(express.json());
const Order = require("../models/newOrder.model");
const PickupAddress = require("../models/pickupAddress.model");
const { generateUniqueOrderIds } = require("../utils/generateUniqueOrderId");
const {
  createWooCommerceWebhook,
} = require("./WooCommerce/woocommerce.controller");

// Shopify's Client Credentials grant (POST /admin/oauth/access_token with
// the store's Client ID + Client Secret) is how a Custom App gets its
// access token — and that token is short-lived (observed expires_in
// ~86399s, i.e. under 24h), not a one-time/permanent credential. There's no
// separate "refresh token" step; getting a new one is the exact same call.
const generateShopifyAccessToken = async (storeURL, storeClientId, storeClientSecret) => {
  const response = await axios.post(
    `https://${storeURL}/admin/oauth/access_token`,
    {
      grant_type: "client_credentials",
      client_id: storeClientId,
      client_secret: storeClientSecret,
    },
    { headers: { "Content-Type": "application/json" } }
  );
  const { access_token, expires_in } = response.data || {};
  if (!access_token) throw new Error("Shopify did not return an access_token");
  return {
    accessToken: access_token,
    // Shave a safety buffer off Shopify's own expiry — see
    // SHOPIFY_TOKEN_REFRESH_BUFFER_MS below for why.
    expiresAt: new Date(Date.now() + (expires_in || 86399) * 1000),
  };
};

const SHOPIFY_TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // refresh 5 min before actual expiry

// Returns a valid Shopify access token for this specific store, refreshing
// it first if it's missing or within SHOPIFY_TOKEN_REFRESH_BUFFER_MS of
// expiring. Every Shopify API call site should call this immediately
// before making its request rather than reading store.storeAccessToken
// directly — that's what keeps this self-healing instead of requiring a
// seller to notice and re-paste a token roughly once a day. Operates only
// on the single `store` document passed in (keyed by its own _id), so
// having multiple Shopify channels connected refreshes each independently
// with no cross-contamination.
const getValidShopifyAccessToken = async (store) => {
  const hasValidToken =
    store.storeAccessToken &&
    store.storeAccessTokenExpiresAt &&
    new Date(store.storeAccessTokenExpiresAt).getTime() - Date.now() > SHOPIFY_TOKEN_REFRESH_BUFFER_MS;

  if (hasValidToken) return store.storeAccessToken;

  if (!store.storeClientId || !store.storeClientSecret) {
    throw new Error(`Store ${store.storeURL} has no Client ID/Secret on file — cannot refresh its Shopify access token.`);
  }

  console.log(`🔄 Refreshing Shopify access token for store ${store.storeURL}...`);
  const { accessToken, expiresAt } = await generateShopifyAccessToken(
    store.storeURL,
    store.storeClientId,
    store.storeClientSecret
  );

  await AllChannel.findByIdAndUpdate(store._id, {
    $set: { storeAccessToken: accessToken, storeAccessTokenExpiresAt: expiresAt },
  });
  console.log(`✅ Shopify access token refreshed for store ${store.storeURL}, expires at ${expiresAt.toISOString()}`);

  // Keep the in-memory doc consistent in case the caller keeps using
  // `store` afterward instead of re-fetching it.
  store.storeAccessToken = accessToken;
  store.storeAccessTokenExpiresAt = expiresAt;

  return accessToken;
};

const createWebhook = async (storeURL, storeAccessToken) => {
  const webhookURL = "https://api.delightcargo.in/v1/channel/webhook/orders";
  const webhookTopic = "orders/create";

  try {
    let cleanURL = storeURL.replace(/^https?:\/\//i, "").replace(/\/+$/, "").trim();
    let apiDomain = cleanURL;

    // Try fetching shop details to get the primary myshopify domain
    try {
      const shopRes = await axios.get(
        `https://${cleanURL}/admin/api/2025-01/shop.json`,
        {
          headers: {
            "X-Shopify-Access-Token": storeAccessToken,
            "Content-Type": "application/json",
          },
          timeout: 10000,
        }
      );
      if (shopRes.data?.shop?.myshopify_domain) {
        apiDomain = shopRes.data.shop.myshopify_domain;
        console.log(`Resolved Shopify canonical domain: ${apiDomain}`);
      }
    } catch (shopErr) {
      console.warn(`Could not fetch shop.json on ${cleanURL}: ${shopErr.message}`);
      if (cleanURL.startsWith("www.")) {
        apiDomain = cleanURL.replace(/^www\./, "");
      }
    }

    // Step 1: Fetch existing webhooks
    const existingWebhooksResponse = await axios.get(
      `https://${apiDomain}/admin/api/2025-01/webhooks.json`,
      {
        headers: {
          "X-Shopify-Access-Token": storeAccessToken,
          "Content-Type": "application/json",
        },
        timeout: 15000,
      }
    );

    const existingWebhooks = existingWebhooksResponse.data.webhooks || [];
    console.log("webhook", existingWebhooks);

    // Step 2: Check if the webhook already exists
    const existingWebhook = existingWebhooks.find(
      (wh) => wh.address === webhookURL && wh.topic === webhookTopic
    );

    if (existingWebhook) {
      console.log("Webhook already exists:", existingWebhook.id);
      return { message: "Webhook already exists", webhook: existingWebhook, resolvedDomain: apiDomain };
    }

    // Step 3: Create the webhook if it does not exist
    const response = await axios.post(
      `https://${apiDomain}/admin/api/2025-01/webhooks.json`,
      {
        webhook: {
          topic: webhookTopic,
          address: webhookURL,
          format: "json",
        },
      },
      {
        headers: {
          "X-Shopify-Access-Token": storeAccessToken,
          "Content-Type": "application/json",
        },
        timeout: 15000,
      }
    );

    console.log("Webhook Created:", response.data);
    return { ...response.data, resolvedDomain: apiDomain };
  } catch (error) {
    const errDetail = error.response?.data || error.message;
    console.error("Error creating webhook:", errDetail);
    return { error: errDetail };
  }
};

const getProductDetails = async (productId, storeURL, accessToken) => {
  try {
    const response = await axios.get(
      `https://${storeURL}/admin/api/2024-01/products/${productId}.json`,
      {
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
        },
      }
    );

    // console.log("Product Response:", response.data);

    const product = response.data.product;

    // Extract weight from the first variant (assuming single variant per product)
    const weight = product.variants?.[0]?.weight || 1; // Default 0 if not found

    // console.log("variants", product.variants);

    return { length: 10, width: 10, height: 10, weight };
  } catch (error) {
    console.error("Error fetching product details:", error);
    return { length: 10, width: 10, height: 10, weight: 0 }; // Default values
  }
};

const fetchExistingOrders = async (req, res) => {
  try {
    const userId = req.user._id;

    const channel = await AllChannel.findOne({
      userId,
      channel: "Shopify",
    });

    if (!channel) {
      return res
        .status(404)
        .json({ success: false, message: "Shopify channel not connected." });
    }

    const accessToken = await getValidShopifyAccessToken(channel);
    const storeURL = channel.storeURL;

    let allOrders = [];
    let pageInfo = null;

    do {
      const response = await axios.get(
        `https://${storeURL}/admin/api/2024-01/orders.json`,
        {
          headers: {
            "X-Shopify-Access-Token": accessToken,
            "Content-Type": "application/json",
          },
          params: {
            status: "any",
            limit: 250,
            ...(pageInfo && { page_info: pageInfo }),
          },
        }
      );

      allOrders.push(...response.data.orders);

      const linkHeader = response.headers["link"];
      if (linkHeader && linkHeader.includes('rel="next"')) {
        const match = linkHeader.match(/page_info=([^&>]+)/);
        pageInfo = match ? match[1] : null;
      } else {
        pageInfo = null;
      }
    } while (pageInfo);

    // Fetch primary seller pickup address
    const primaryPickup = await PickupAddress.findOne({
      userId: channel.userId,
      isPrimary: true,
    }).lean();

    for (const order of allOrders) {
      const compositeOrderId = `${storeURL}-${order.id}`;

      const existingOrder = await Order.findOne({ compositeOrderId });
      if (existingOrder) {
        console.log(`Order ${order.id} already exists. Skipping...`);
        continue;
      }

      // Extract product details
      const productDetails = (order.line_items || []).map((item) => {
        const tax = (item.tax_lines || []).reduce((acc, t) => acc + parseFloat(t.price || 0), 0);
        const discount = (item.discount_allocations || []).reduce((acc, d) => acc + parseFloat(d.amount || 0), 0);
        return {
          id: item.id,
          quantity: item.quantity,
          name: item.name,
          sku: item.sku || "",
          unitPrice: String(item.price || "0"),
          tax: String(tax),
          discount: String(discount),
        };
      });

      // Default package dimensions
      let totalWeight = 0;
      let totalLength = 10,
        totalWidth = 10,
        totalHeight = 10;

      for (const item of (order.line_items || [])) {
        try {
          const productInfo = await getProductDetails(
            item.product_id,
            storeURL,
            accessToken
          );

          totalWeight += productInfo.weight || 0;
          totalLength = Math.max(totalLength, productInfo.length || 0);
          totalWidth = Math.max(totalWidth, productInfo.width || 0);
          totalHeight = Math.max(totalHeight, productInfo.height || 0);
        } catch (err) {
          console.warn(
            `Failed to fetch details for product ${item.product_id}`
          );
        }
      }

      const internalOrderId = await generateUniqueOrderIds(1);

      const pickupAddressObj = (primaryPickup && primaryPickup.pickupAddress)
        ? {
            contactName: primaryPickup.pickupAddress.contactName,
            email: primaryPickup.pickupAddress.email,
            phoneNumber: primaryPickup.pickupAddress.phoneNumber,
            address: primaryPickup.pickupAddress.address,
            pinCode: primaryPickup.pickupAddress.pinCode,
            city: primaryPickup.pickupAddress.city,
            state: primaryPickup.pickupAddress.state,
          }
        : {
            contactName: order.billing_address?.name || "N/A",
            email: order.email || "unknown@example.com",
            phoneNumber: order.billing_address?.phone || "0000000000",
            address: `${order.billing_address?.address1 || ""}, ${order.billing_address?.address2 || ""}`.trim().replace(/^,\s*|,\s*$/g, ""),
            pinCode: order.billing_address?.zip || "000000",
            city: order.billing_address?.city || "Unknown",
            state: order.billing_address?.province || "Unknown",
          };

      const receiverAddressStr = `${order.shipping_address?.address1 || ""}, ${order.shipping_address?.address2 || ""}`.trim().replace(/^,\s*|,\s*$/g, "") || "Not Provided";

      const newOrder = new Order({
        userId: channel.userId,
        orderId: internalOrderId,
        channelId: order.id,
        channel: "Shopify",
        storeUrl: storeURL,
        compositeOrderId,
        pickupAddress: pickupAddressObj,
        receiverAddress: {
          contactName: order.shipping_address?.name || "N/A",
          email: order.email || "unknown@example.com",
          phoneNumber: order.shipping_address?.phone || "0000000000",
          address: receiverAddressStr,
          pinCode: order.shipping_address?.zip || "000000",
          city: order.shipping_address?.city || "Unknown",
          state: order.shipping_address?.province || "Unknown",
        },
        productDetails,
        packageDetails: {
          deadWeight: totalWeight,
          applicableWeight: totalWeight,
          volumetricWeight: {
            length: totalLength,
            width: totalWidth,
            height: totalHeight,
          },
        },
        paymentDetails: {
          method: order.financial_status === "paid" ? "Prepaid" : "COD",
          amount:
            order.financial_status === "paid"
              ? 0
              : parseFloat(order.total_price || 0),
        },
        status: "new",
        tracking: [
          {
            status: "new",
            StatusLocation: order.shipping_address?.city || "N/A",
            StatusDateTime: new Date(),
            Instructions: "Order fetched from Shopify",
          },
        ],
      });

      await newOrder.save();
      console.log(`Saved new order ${order.order_number} (${order.id})`);
    }

    channel.lastSync = new Date();
    await channel.save();

    res.status(200).json({
      success: true,
      message: "All orders synced successfully.",
    });
  } catch (error) {
    console.error(
      "Error fetching existing orders:",
      error.response?.data || error.message
    );
    res.status(500).json({
      success: false,
      message: "Error in syncing orders.",
    });
  }
};

// Call it directly

const webhookhandler = async (req, res) => {
  try {
    const rawDomain = req.headers["x-shopify-shop-domain"];
    console.log("Shopify webhook header domain:", rawDomain);

    // Handle express.raw Buffer body
    const shopifyOrder = Buffer.isBuffer(req.body)
      ? JSON.parse(req.body.toString("utf8"))
      : (typeof req.body === "string" ? JSON.parse(req.body) : req.body);

    if (!shopifyOrder) {
      return res.status(400).json({ error: "Invalid webhook body" });
    }

    const cleanDomain = rawDomain ? rawDomain.replace(/^https?:\/\//i, "").replace(/\/+$/, "").trim() : "";

    let user = await AllChannel.findOne({
      $or: [
        { storeURL: cleanDomain },
        { myshopifyDomain: cleanDomain },
        { storeURL: { $regex: cleanDomain.replace(/\./g, "\\."), $options: "i" } },
      ],
    });

    if (!user && cleanDomain) {
      const domainPrefix = cleanDomain.split(".")[0];
      user = await AllChannel.findOne({
        $or: [
          { storeURL: { $regex: domainPrefix, $options: "i" } },
          { storeName: { $regex: domainPrefix, $options: "i" } },
        ],
      });
    }

    if (!user) {
      console.error("Store not found in AllChannel for domain:", cleanDomain);
      return res.status(404).json({ error: "Store not found" });
    }

    // Auto-populate myshopifyDomain if missing
    if (!user.myshopifyDomain && cleanDomain.includes("myshopify.com")) {
      user.myshopifyDomain = cleanDomain;
      await user.save().catch(e => console.warn("Could not auto-save myshopifyDomain:", e.message));
    }

    const storeURL = user.myshopifyDomain || user.storeURL;
    const compositeOrderId = `${storeURL}-${shopifyOrder.id}`;

    // Check for existing order using compositeOrderId
    const existingOrder = await Order.findOne({ compositeOrderId });
    if (existingOrder) {
      console.log(`Order ${compositeOrderId} already exists, skipping...`);
      return res.status(200).json({ message: "Duplicate order ignored" });
    }

    // Fetch primary seller pickup address if available
    const primaryPickup = await PickupAddress.findOne({
      userId: user.userId,
      isPrimary: true,
    }).lean();

    let webhookAccessToken;
    try {
      webhookAccessToken = await getValidShopifyAccessToken(user);
    } catch (tokenErr) {
      console.error("Failed to obtain Shopify access token for webhook order:", tokenErr.response?.data || tokenErr.message);
      return res.status(500).json({ error: "Failed to authenticate with Shopify" });
    }

    // Fetch store location details safely if fallback needed
    let locations;
    try {
      const locationRes = await axios.get(
        `https://${storeURL}/admin/api/2024-01/locations.json`,
        {
          headers: {
            "X-Shopify-Access-Token": webhookAccessToken,
            "Content-Type": "application/json",
          },
          timeout: 10000,
        }
      );
      locations = locationRes.data?.locations?.[0];
    } catch (locErr) {
      console.warn("Locations fetch warning:", locErr.message);
    }

    // Extract product details with tax and discount
    const productDetails = (shopifyOrder.line_items || []).map((item) => {
      const tax = (item.tax_lines || []).reduce((acc, t) => acc + parseFloat(t.price || 0), 0);
      const discount = (item.discount_allocations || []).reduce((acc, d) => acc + parseFloat(d.amount || 0), 0);
      return {
        id: item.id,
        quantity: item.quantity,
        name: item.name,
        sku: item.sku || "",
        unitPrice: String(item.price || "0"),
        tax: String(tax),
        discount: String(discount),
      };
    });

    // Fetch package weight & dimensions
    let totalWeight = 0;
    let totalLength = 10,
      totalWidth = 10,
      totalHeight = 10;

    for (const item of (shopifyOrder.line_items || [])) {
      const productInfo = await getProductDetails(
        item.product_id,
        storeURL,
        webhookAccessToken
      );

      totalWeight += productInfo.weight || 0;
      totalLength = Math.max(totalLength, productInfo.length || 0);
      totalWidth = Math.max(totalWidth, productInfo.width || 0);
      totalHeight = Math.max(totalHeight, productInfo.height || 0);
    }

    const internalOrderId = await generateUniqueOrderIds(1);

    const pickupAddressObj = (primaryPickup && primaryPickup.pickupAddress)
      ? {
          contactName: primaryPickup.pickupAddress.contactName,
          email: primaryPickup.pickupAddress.email,
          phoneNumber: primaryPickup.pickupAddress.phoneNumber,
          address: primaryPickup.pickupAddress.address,
          pinCode: primaryPickup.pickupAddress.pinCode,
          city: primaryPickup.pickupAddress.city,
          state: primaryPickup.pickupAddress.state,
        }
      : {
          contactName: shopifyOrder.billing_address?.name || "N/A",
          email: shopifyOrder.email || "abc@gmail.com",
          phoneNumber: shopifyOrder.billing_address?.phone || "0000000000",
          address: `${shopifyOrder.billing_address?.address1 || ""}, ${shopifyOrder.billing_address?.address2 || ""}`.trim().replace(/^,\s*|,\s*$/g, ""),
          pinCode: shopifyOrder.billing_address?.zip || "000000",
          city: shopifyOrder.billing_address?.city || "abc",
          state: locations?.localized_province_name || shopifyOrder.billing_address?.province || "N/A",
        };

    const receiverAddressStr = `${shopifyOrder.shipping_address?.address1 || ""}, ${shopifyOrder.shipping_address?.address2 || ""}`.trim().replace(/^,\s*|,\s*$/g, "") || "Not Provided";

    const newOrder = new Order({
      userId: user.userId,
      orderId: internalOrderId,
      compositeOrderId,
      channelId: shopifyOrder.id,
      channel: "Shopify",
      storeUrl: storeURL,
      pickupAddress: pickupAddressObj,
      receiverAddress: {
        contactName: shopifyOrder.shipping_address?.name || "N/A",
        email: shopifyOrder.email || "abc@gmail.com",
        phoneNumber: shopifyOrder.shipping_address?.phone || "0000000000",
        address: receiverAddressStr,
        pinCode: shopifyOrder.shipping_address?.zip || "000000",
        city: shopifyOrder.shipping_address?.city || "abc",
        state: shopifyOrder.shipping_address?.province || "abc",
      },
      productDetails,
      packageDetails: {
        deadWeight: totalWeight,
        applicableWeight: totalWeight,
        volumetricWeight: {
          length: totalLength,
          width: totalWidth,
          height: totalHeight,
        },
      },
      paymentDetails: {
        method: shopifyOrder.financial_status === "paid" ? "Prepaid" : "COD",
        amount:
          shopifyOrder.financial_status === "paid"
            ? 0
            : parseFloat(shopifyOrder.total_price || 0),
      },
      status: "new",
      tracking: [
        {
          status: "new",
          StatusLocation: shopifyOrder.shipping_address?.city || "N/A",
          StatusDateTime: new Date(),
          Instructions: "Order synced from Shopify",
        },
      ],
    });

    await newOrder.save();

    res.status(200).json({
      message: "Order synced successfully",
      orderId: newOrder.orderId,
    });
  } catch (error) {
    console.error("Error syncing Shopify order:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
};

// ✅ Store Channel Details and Register Webhook
const storeAllChannelDetails = async (req, res) => {
  try {
    console.log("📦 Received Store Data:", req.body);
    const userId = req.user?._id;

    const {
      channel,
      storeName,
      storeURL,
      storeClientId,
      storeClientSecret,
      storeAccessToken,
      orderSyncFrequency,
      paymentStatusCOD,
      paymentStatusPrepaid,
      multiSeller,
      syncInventory,
      syncDate,
    } = req.body;

    if (!storeName || !storeURL || !storeClientId || !storeClientSecret) {
      return res
        .status(400)
        .json({ success: false, message: "Missing required fields" });
    }

    const cleanStoreURL = storeURL.replace(/^https?:\/\//i, "").replace(/\/+$/, "").trim();

    const existingStore = await AllChannel.findOne({
      $or: [{ storeURL }, { storeURL: cleanStoreURL }],
    });
    if (existingStore) {
      return res.status(400).json({ message: "Store URL already exists" });
    }

    // ✅ Generate the Shopify access token ourselves from the Client
    // ID/Secret the seller provides — a Custom App's token is a Client
    // Credentials grant we can request directly, so there's no reason to
    // ask the seller to separately generate and paste one in (and it's
    // short-lived anyway, see getValidShopifyAccessToken).
    let shopifyAccessToken;
    let shopifyAccessTokenExpiresAt;
    if (channel === "Shopify") {
      try {
        const tokenResult = await generateShopifyAccessToken(cleanStoreURL, storeClientId, storeClientSecret);
        shopifyAccessToken = tokenResult.accessToken;
        shopifyAccessTokenExpiresAt = tokenResult.expiresAt;
      } catch (tokenErr) {
        console.error("❌ Failed to generate Shopify access token:", tokenErr.response?.data || tokenErr.message);
        return res.status(400).json({
          success: false,
          message: "Failed to authenticate with Shopify using the provided Store URL, Client ID, and Client Secret. Please verify these are correct.",
          error: tokenErr.response?.data || tokenErr.message,
        });
      }
    }

    // ✅ Register Webhook
    let webHook;
    let webhookId = null;
    let myshopifyDomain = "";

    if (channel === "Shopify") {
      webHook = await createWebhook(cleanStoreURL, shopifyAccessToken);
      console.log("✅ Webhook creation response:", webHook);

      if (webHook.error) {
        const errorDetail = typeof webHook.error === "object"
          ? JSON.stringify(webHook.error)
          : webHook.error;
        return res.status(400).json({
          success: false,
          message: `Failed to create webhook on Shopify: ${errorDetail}. Please check Store URL, Client ID, and Client Secret.`,
        });
      }

      webhookId = webHook?.webhook?.id || webHook?.id || "";
      if (webHook.resolvedDomain) {
        myshopifyDomain = webHook.resolvedDomain;
      }
    }

    if (channel === "WooCommerce") {
      webHook = await createWooCommerceWebhook(
        cleanStoreURL,
        storeClientId,
        storeClientSecret
      );
      if (webHook?.error) {
        return res.status(400).json({
          success: false,
          message: "Failed to create webhook on WooCommerce. Please check Consumer Key & Secret.",
        });
      }
      webhookId = webHook?.id || webHook?.webhook?.id || "";
    }

    const newChannel = new AllChannel({
      userId,
      channel,
      storeName,
      storeURL: cleanStoreURL,
      storeClientId,
      storeClientSecret,
      // WooCommerce still uses whatever the seller pasted in (its Consumer
      // Key/Secret double as the credential directly, no token-exchange
      // step); Shopify always uses the token we just generated ourselves.
      storeAccessToken: channel === "Shopify" ? shopifyAccessToken : storeAccessToken,
      storeAccessTokenExpiresAt: channel === "Shopify" ? shopifyAccessTokenExpiresAt : undefined,
      orderSyncFrequency,
      paymentStatus: {
        COD: paymentStatusCOD || "",
        Prepaid: paymentStatusPrepaid || "",
      },
      multiSeller,
      syncInventory,
      syncFromDate: syncDate || null,
      webhookId: webhookId ? String(webhookId) : null,
      myshopifyDomain,
    });

    await newChannel.save();

    return res.status(201).json({
      success: true,
      message: "Channel details stored successfully.",
      data: newChannel,
    });
  } catch (error) {
    console.error("❌ Error storing channel details:", error);
    return res
      .status(500)
      .json({ success: false, message: error.message || "Internal Server Error." });
  }
};

// ✅ Fetch Orders from Shopify
// const axios = require('axios');
// const AllChannel = require('../models/AllChannel'); // Adjust the path accordingly
// const Order = require('../models/Order'); // Adjust the path accordingly

const getOrders = async (storeURL) => {
  try {
    const user = await AllChannel.findOne({ storeURL });

    if (!user) {
      console.log(`No user found for store: ${storeURL}`);
      return;
    }

    const response = await axios.get(
      `https://${storeURL}/admin/api/2024-01/orders.json`,
      {
        headers: {
          "X-Shopify-Access-Token": user.storeAccessToken,
          "Content-Type": "application/json",
        },
      }
    );
// console.log("response",response.data)
    const response1 = await axios.get(
      `https://${storeURL}/admin/api/2024-01/locations.json`,
      {
        headers: {
          "X-Shopify-Access-Token": user.storeAccessToken,
          "Content-Type": "application/json",
        },
      }
    );
    const locations = response1.data.locations[0];
    console.log("locations", locations);

    // const orders = response.data.orders;
    // console.log(orders)
    console.log("Store Name:", response.data.orders[0].fulfillments);

    console.log("✅ Orders processed successfully!");
  } catch (error) {
    console.error("❌ Error fetching orders:", error);
  }
};

// getOrders("www.savagemods.com");

const fulfillOrder = async (req, res) => {
  try {
    console.log("body", req.body);
    const { id, provider, awb_number } = req.body;
    console.log("Received fulfillment request:", {
      id,
      provider,
      awb_number,
    });

    if (!id || !provider || !awb_number) {
      return res.status(400).json({
        message: "Missing required fields: orderId, provider, waybill",
      });
    }

    const userId = req.user._id;
    const channel = await AllChannel.findOne({
      userId: userId,
      channel: "Shopify",
    });

    if (!channel) {
      return res
        .status(404)
        .json({ message: "Shopify channel not found for this user" });
    }

    const shopifyStore = channel.myshopifyDomain || channel.storeURL;
    let accessToken;
    try {
      accessToken = await getValidShopifyAccessToken(channel);
    } catch (tokenErr) {
      console.error("Error obtaining Shopify access token:", tokenErr.response?.data || tokenErr.message);
      return res.status(500).json({ message: "Failed to authenticate with Shopify" });
    }

    // Fetch order details
    let orderDetails;
    try {
      const orderResponse = await axios.get(
        `https://${shopifyStore}/admin/api/2024-04/orders/${id}.json`,
        {
          headers: { "X-Shopify-Access-Token": accessToken },
        }
      );
      orderDetails = orderResponse.data.order;
    } catch (error) {
      console.error(
        "Error fetching order details:",
        error.response?.data || error
      );
      return res.status(404).json({ message: "Order not found on Shopify" });
    }

    console.log("Order details:", orderDetails);

    // Check if the order is already fulfilled
    if (orderDetails.fulfillment_status === "fulfilled") {
      return res.status(400).json({ message: "Order is already fulfilled" });
    }

    // Check if the order is a COD order
    const isCOD =
      orderDetails.payment_gateway_names.includes("cash_on_delivery");

    // If the order is not COD and payment is still pending, do not fulfill
    if (!isCOD && orderDetails.financial_status === "pending") {
      console.log("not fulfilled");
      return res.status(400).json({
        message: "Order cannot be fulfilled as payment is still pending.",
      });
    }

    // Shopify deprecated POST /orders/{id}/fulfillments.json (it now
    // returns 406 under current API versions) in favor of the
    // FulfillmentOrder-based flow — see fulfillShopifyOrderHelper above for
    // the same fix applied to the automatic push-back path.
    let fulfillmentOrderId;
    try {
      const foRes = await axios.get(
        `https://${shopifyStore}/admin/api/2024-04/orders/${id}/fulfillment_orders.json`,
        { headers: { "X-Shopify-Access-Token": accessToken } }
      );
      const fulfillmentOrders = foRes.data?.fulfillment_orders || [];
      const openFulfillmentOrder = fulfillmentOrders.find((fo) => fo.status === "open") || fulfillmentOrders[0];
      fulfillmentOrderId = openFulfillmentOrder?.id;
    } catch (error) {
      console.error("Error fetching fulfillment orders:", error.response?.data || error.message);
      return res
        .status(500)
        .json({ message: "Error fetching fulfillment orders from Shopify" });
    }

    if (!fulfillmentOrderId) {
      return res
        .status(400)
        .json({ message: "No fulfillment order found for this Shopify order" });
    }

    // Fulfill the order
    try {
      const fulfillmentResponse = await axios.post(
        `https://${shopifyStore}/admin/api/2024-04/fulfillments.json`,
        {
          fulfillment: {
            notify_customer: true, // Notify customer via email
            tracking_info: {
              number: awb_number,
              company: provider,
              url: `https://www.delightcargo.com/track/${awb_number}`, // Adjust based on courier tracking link
            },
            line_items_by_fulfillment_order: [
              { fulfillment_order_id: fulfillmentOrderId },
            ],
          },
        },
        {
          headers: {
            "X-Shopify-Access-Token": accessToken,
            "Content-Type": "application/json",
          },
        }
      );

      console.log("Order Fulfilled:", fulfillmentResponse.data);

      return res.status(200).json({
        message: "Order fulfilled successfully",
        trackingInfo: {
          trackingNumber: awb_number,
          courier: provider,
          trackingURL: `https://www.delightcargo.com/track/${awb_number}`, // Adjust for your provider
        },
      });
    } catch (error) {
      console.error("Error fulfilling order:", error.response?.data || error);
      return res.status(500).json({
        message: "Error fulfilling order on Shopify",
        error: error.response?.data,
      });
    }
  } catch (error) {
    console.error("Unexpected error in fulfillOrder:", error);
    return res.status(500).json({ message: "Internal server error", error });
  }
};

// Example Usage
// fulfillOrder("1234567890", "TRK123456", "Ecom Express");

const getAllChannel = async (req, res) => {
  try {
    const userId = req.user._id;
    const allChannels = await AllChannel.find({ userId: userId });
    res.status(200).json({ success: true, data: allChannels });
  } catch (error) {
    console.error("Error fetching channels:", error);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
};

const getOneChannel = async (req, res) => {
  const { id } = req.params;

  try {
    const channel = await AllChannel.findOne({ _id: id });
    // console.log("channel",channel)

    if (!channel) {
      return res.status(404).json({ message: "Channel not found" });
    }

    res.status(200).json(channel);
  } catch (error) {
    console.error("Error fetching channel:", error);
    res.status(500).json({ message: "Internal Server Error" });
  }
};

const updateChannel = async (req, res) => {
  const { id } = req.params;
  let updatedData = { ...req.body };

  // Convert syncDate to Date object if provided
  if (req.body.syncDate) {
    updatedData.syncFromDate = new Date(req.body.syncDate);
  }

  // Same normalization as storeAllChannelDetails — an edited storeURL must
  // stay in the bare canonical domain form or inbound webhook lookups break.
  if (typeof updatedData.storeURL === "string") {
    updatedData.storeURL = updatedData.storeURL
      .trim()
      .replace(/^https?:\/\//i, "")
      .replace(/\/+$/, "");
  }

  try {
    // Check if the channel exists
    const existingChannel = await AllChannel.findById(id);
    if (!existingChannel) {
      return res.status(404).json({ message: "Channel not found" });
    }

    // Update the channel details
    let updatedChannel = await AllChannel.findByIdAndUpdate(
      id,
      { $set: updatedData }, // Ensure syncDate is properly formatted
      { new: true } // Return the updated document
    );

    // (Re-)register the webhook using whatever credentials are now on the
    // document — previously this just patched the DB with no attempt to
    // actually verify/register anything with Shopify/WooCommerce, so a
    // corrected credential could be saved while webhookId silently stayed
    // empty and orders kept not syncing.
    let webhookStatus = "skipped";
    let webhookError = null;

    if (updatedChannel.channel === "Shopify") {
      let freshToken;
      try {
        // Reuses the still-valid stored token, or regenerates it from
        // whatever Client ID/Secret now sit on the document (e.g. the
        // seller just corrected them) — the seller never needs to supply
        // an access token here either.
        freshToken = await getValidShopifyAccessToken(updatedChannel);
      } catch (tokenErr) {
        webhookStatus = "failed";
        webhookError = tokenErr.response?.data || tokenErr.message;
        console.error(`❌ Failed to obtain Shopify access token for channel ${id}:`, webhookError);
      }

      if (freshToken) {
        const webHook = await createWebhook(updatedChannel.storeURL, freshToken);
        if (webHook?.error) {
          webhookStatus = "failed";
          webhookError = webHook.error;
          console.error(`❌ Shopify webhook (re-)registration failed for channel ${id}:`, webHook.error);
        } else {
          const webhookId = webHook?.webhook?.id || webHook?.id;
          if (webhookId) {
            updatedChannel = await AllChannel.findByIdAndUpdate(
              id,
              {
                $set: {
                  webhookId: String(webhookId),
                  ...(webHook.resolvedDomain ? { myshopifyDomain: webHook.resolvedDomain } : {}),
                },
              },
              { new: true }
            );
            webhookStatus = "ok";
          } else {
            webhookStatus = "failed";
            webhookError = "Shopify returned no webhook id.";
            console.error(`❌ Shopify webhook call for channel ${id} returned no id:`, webHook);
          }
        }
      }
    } else if (updatedChannel.channel === "WooCommerce") {
      try {
        const webHook = await createWooCommerceWebhook(
          updatedChannel.storeURL,
          updatedChannel.storeClientId,
          updatedChannel.storeClientSecret
        );
        const webhookId = webHook?.id || webHook?.webhook?.id;
        if (webhookId) {
          updatedChannel = await AllChannel.findByIdAndUpdate(
            id,
            { $set: { webhookId: String(webhookId) } },
            { new: true }
          );
          webhookStatus = "ok";
        } else {
          webhookStatus = "failed";
          webhookError = "WooCommerce returned no webhook id.";
          console.error(`❌ WooCommerce webhook call for channel ${id} returned no id:`, webHook);
        }
      } catch (wcErr) {
        webhookStatus = "failed";
        webhookError = wcErr.message;
        console.error(`❌ WooCommerce webhook (re-)registration failed for channel ${id}:`, wcErr.message);
      }
    }

    res.status(200).json({
      message: "Channel updated successfully",
      channel: updatedChannel,
      webhookStatus, // "ok" | "failed" | "skipped" (skipped = not Shopify/WooCommerce)
      webhookError,
    });
  } catch (error) {
    console.error("Error updating channel:", error);
    res.status(500).json({ message: "Internal Server Error" });
  }
};

const deleteChannel = async (req, res) => {
  const { id } = req.params;

  try {
    // Find and delete the channel
    const deletedChannel = await AllChannel.findByIdAndDelete(id);

    if (!deletedChannel) {
      return res.status(404).json({ message: "Channel not found" });
    }

    res.status(200).json({ message: "Channel deleted successfully" });
  } catch (error) {
    console.error("Error deleting channel:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};

// Shopify fulfillment events only accept this fixed vocabulary — there's no
// native "RTO" concept, so RTO/undelivered/lost map to "failure" with the
// real Shiproxx status preserved in the order's tracking history (not lost,
// just not representable as a distinct Shopify fulfillment event).
const shiproxxToShopifyFulfillmentEvent = (shiproxxStatus) => {
  const map = {
    "In-transit": "in_transit",
    "Out for Delivery": "out_for_delivery",
    "Delivered": "delivered",
    "Undelivered": "failure",
    "Lost": "failure",
    "RTO": "failure",
    "RTO In-transit": "failure",
    "RTO Delivered": "failure",
  };
  return map[shiproxxStatus] || null;
};

// Auto-triggered Shopify status/tracking push-back — wired into
// newOrder.model.js's post-save/post-findOneAndUpdate hooks so it fires on
// every status change regardless of which courier booked/updated the
// shipment. Shopify's model is: create one Fulfillment on first shipment
// scan, then post Fulfillment Events for subsequent status changes — there
// is no single call that both fulfills an order AND sets an arbitrary
// tracking status, so an order that's already progressed past "just
// booked" (e.g. a backfill call for an already-Delivered order) gets its
// fulfillment created AND immediately advanced with the matching event in
// the same pass, rather than getting stuck at a generic "fulfilled" state.
//
// notifyCustomer defaults to true for normal live traffic; pass false from
// a one-off backfill script so Shopify doesn't email customers a surprise
// "shipped" notice for orders that may already be delivered.
const fulfillShopifyOrderHelper = async (order, notifyCustomer = true) => {
  try {
    if (!order || order.channel !== "Shopify" || !order.awb_number) return;

    const channel = await AllChannel.findOne({
      userId: order.userId,
      channel: "Shopify",
    });

    if (!channel) return;

    const shopifyStore = channel.myshopifyDomain || channel.storeURL;
    const shopifyOrderId = order.compositeOrderId
      ? order.compositeOrderId.split("-").pop()
      : order.channelId;

    if (!shopifyOrderId) return;

    let accessToken;
    try {
      accessToken = await getValidShopifyAccessToken(channel);
    } catch (tokenErr) {
      console.error(`❌ Failed to obtain Shopify access token for order ${shopifyOrderId}:`, tokenErr.response?.data || tokenErr.message);
      return;
    }

    const baseUrl = `https://${shopifyStore}/admin/api/2025-01`;
    const authHeaders = { headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" } };

    console.log(`🚚 Syncing Fulfillment to Shopify for Order ${shopifyOrderId} | AWB: ${order.awb_number} | Status: ${order.status} | Courier: ${order.provider || order.courierName}`);

    let shopifyOrderData;
    try {
      const orderRes = await axios.get(`${baseUrl}/orders/${shopifyOrderId}.json`, { ...authHeaders, timeout: 10000 });
      shopifyOrderData = orderRes.data?.order;
    } catch (err) {
      console.error(`❌ Error fetching Shopify order ${shopifyOrderId}:`, err.response?.data || err.message);
      return;
    }
    if (!shopifyOrderData) return;

    const existingFulfillment = shopifyOrderData.fulfillments?.[0];

    // --- First shipment scan: create the fulfillment ---
    if (!existingFulfillment) {
      // Anything before booking, or a cancelled order, has nothing to
      // fulfill. Every other status — including one that's already well
      // past "Booked" — should still get a fulfillment created now rather
      // than silently doing nothing.
      const NON_FULFILLABLE_STATUSES = ["new", "processing", "Cancelled"];
      if (NON_FULFILLABLE_STATUSES.includes(order.status)) {
        console.log(`ℹ️ Shiproxx status "${order.status}" doesn't warrant creating a Shopify fulfillment yet — skipping.`);
        return;
      }
      if (shopifyOrderData.fulfillment_status === "fulfilled") return; // already fulfilled elsewhere

      let fulfillmentOrderId;
      try {
        const foRes = await axios.get(`${baseUrl}/orders/${shopifyOrderId}/fulfillment_orders.json`, { ...authHeaders, timeout: 10000 });
        const fulfillmentOrders = foRes.data?.fulfillment_orders || [];
        const openFulfillmentOrder = fulfillmentOrders.find((fo) => fo.status === "open") || fulfillmentOrders[0];
        fulfillmentOrderId = openFulfillmentOrder?.id;
      } catch (err) {
        console.error(`❌ Error fetching fulfillment orders for ${shopifyOrderId}:`, err.response?.data || err.message);
        return;
      }
      if (!fulfillmentOrderId) {
        console.error(`❌ No fulfillment order found for Shopify order ${shopifyOrderId}.`);
        return;
      }

      let newFulfillmentId;
      try {
        const fulfillRes = await axios.post(
          `${baseUrl}/fulfillments.json`,
          {
            fulfillment: {
              notify_customer: notifyCustomer,
              tracking_info: {
                number: order.awb_number,
                company: order.provider || order.courierName || "Custom Carrier",
                url: `https://api.delightcargo.in/track/${order.awb_number}`,
              },
              line_items_by_fulfillment_order: [
                { fulfillment_order_id: fulfillmentOrderId },
              ],
            },
          },
          authHeaders
        );
        newFulfillmentId = fulfillRes.data?.fulfillment?.id;
        console.log(`✅ Shopify order ${shopifyOrderId} fulfilled (${order.status}).`);
      } catch (err) {
        console.error(`❌ Error creating fulfillment for Shopify order ${shopifyOrderId}:`, err.response?.data || err.message);
        return;
      }

      // If the order has already progressed past "just booked", immediately
      // post the matching fulfillment event too — otherwise Shopify stays
      // parked at the initial "fulfilled" state forever, since there's no
      // future status change left to trigger the update.
      const initialEventStatus = shiproxxToShopifyFulfillmentEvent(order.status);
      if (newFulfillmentId && initialEventStatus) {
        try {
          await axios.post(
            `${baseUrl}/fulfillments/${newFulfillmentId}/events.json`,
            { event: { status: initialEventStatus } },
            authHeaders
          );
          console.log(`✅ Shopify fulfillment ${newFulfillmentId} event posted: ${order.status} → ${initialEventStatus}`);
        } catch (err) {
          console.error(`❌ Error posting initial fulfillment event for Shopify order ${shopifyOrderId}:`, err.response?.data || err.message);
        }
      }
      return;
    }

    // --- Fulfillment already exists: cancel or post a status event ---
    if (order.status === "Cancelled") {
      try {
        await axios.post(`${baseUrl}/fulfillments/${existingFulfillment.id}/cancel.json`, {}, authHeaders);
        console.log(`✅ Shopify fulfillment ${existingFulfillment.id} cancelled.`);
      } catch (err) {
        console.error(`❌ Error cancelling Shopify fulfillment ${existingFulfillment.id}:`, err.response?.data || err.message);
      }
      return;
    }

    const eventStatus = shiproxxToShopifyFulfillmentEvent(order.status);
    if (!eventStatus) {
      console.log(`ℹ️ No Shopify fulfillment-event mapping for status "${order.status}" — skipping.`);
      return;
    }

    try {
      await axios.post(
        `${baseUrl}/fulfillments/${existingFulfillment.id}/events.json`,
        { event: { status: eventStatus } },
        authHeaders
      );
      console.log(`✅ Shopify fulfillment ${existingFulfillment.id} event posted: ${order.status} → ${eventStatus}`);
    } catch (err) {
      console.error(`❌ Error posting fulfillment event for Shopify order ${shopifyOrderId}:`, err.response?.data || err.message);
    }
  } catch (error) {
    console.error(`❌ Error in fulfillShopifyOrderHelper:`, error.message);
  }
};

module.exports = {
  createWebhook,
  storeAllChannelDetails,
  webhookhandler,
  getOrders,
  getAllChannel,
  getOneChannel,
  updateChannel,
  deleteChannel,
  fulfillOrder,
  fulfillShopifyOrderHelper,
  fetchExistingOrders,
};
