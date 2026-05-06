const axios = require("axios");
const Order = require("../../models/newOrder.model");
const AllChannel = require("../allChannel.model"); // Adjust path if necessary

// const storeURL = "https://www.mahadevrediments.in/";
// const consumerKey = "ck_167c49505d20d4ec91bc4bb73459df2c4e7fc489";
// const consumerSecret = "cs_e479f1773fc3fc267c0ca01ce1845405d8c5ff66";

// Function to fetch orders from WooCommerce
const fetchWooCommerceOrders = async (
  storeURL,
  consumerKey,
  consumerSecret
) => {
  try {
    const response = await axios.get(`${storeURL}/wp-json/wc/v3/orders`, {
      auth: {
        username: consumerKey,
        password: consumerSecret,
      },
    });

    return response.data; // Returns orders from WooCommerce
  } catch (error) {
    console.error(
      "Error fetching WooCommerce orders:",
      error.response?.data || error
    );
    throw new Error("Failed to fetch orders from WooCommerce.");
  }
};
// fetchWooCommerceOrders(storeURL,consumerKey,consumerSecret)
// Payment method mapping
function mapWCPayment(method, methodTitle) {
  if (
    ["COD", "Cash on Delivery", "cash_on_delivery"].includes(method) ||
    /cod/i.test(method) ||
    /cash on delivery/i.test(methodTitle)
  )
    return "COD";
  return "Prepaid";
}

// Validate WooCommerce webhook signature (HMAC SHA256)
function isWooCommerceRequestValid(req) {
  const signature = req.headers["x-wc-webhook-signature"];
  if (!signature || !WOOCOMMERCE_WEBHOOK_SECRET) return false;
  const expected = crypto
    .createHmac("sha256", WOOCOMMERCE_WEBHOOK_SECRET)
    .update(JSON.stringify(req.body), "utf8")
    .digest("base64");
  return expected === signature;
}
//webhook creation
const checkExistingWooCommerceWebhooks = async (
  storeURL,
  consumerKey,
  consumerSecret
) => {
  try {
    const response = await axios.get(`${storeURL}/wp-json/wc/v3/webhooks`, {
      auth: {
        username: consumerKey,
        password: consumerSecret,
      },
    });

    return response.data; // Returns all existing webhooks
  } catch (error) {
    console.error(
      "❌ Error fetching WooCommerce webhooks:",
      error.response?.data || error
    );
    return [];
  }
};

const createWooCommerceWebhook = async (
  storeURL,
  consumerKey,
  consumerSecret
) => {
  try {
    // 🔍 Step 1: Check if a webhook already exists
    const existingWebhooks = await checkExistingWooCommerceWebhooks(
      storeURL,
      consumerKey,
      consumerSecret
    );

    // 🔄 Step 2: Filter Webhooks for our "Order Created" event
    const existingWebhook = existingWebhooks.find(
      (webhook) =>
        webhook.topic.includes("order") &&
        webhook.delivery_url ===
          "https://api.shipexindia.com/v1/channel/webhook/woocommerce"
    );

    if (existingWebhook) {
      console.log("✅ Webhook already exists:", existingWebhook);
      return existingWebhook; // Return existing webhook details
    }

    // 🚀 Step 3: Create new webhook if none exists
    const response = await axios.post(
      `${storeURL}/wp-json/wc/v3/webhooks`,
      {
        name: "Order Created Webhook",
        topic: "order.created",
        delivery_url:
          "https://api.shipexindia.com/v1/channel/webhook/woocommerce",
        status: "active",
      },
      {
        auth: {
          username: consumerKey,
          password: consumerSecret,
        },
      }
    );

    console.log("✅ Webhook created successfully:", response.data);
    return response.data; // Return newly created webhook details
  } catch (error) {
    console.error(
      "❌ Error creating WooCommerce webhook:",
      error.response?.data || error
    );
    throw new Error("Failed to create WooCommerce webhook.");
  }
};

//webhook handler

// Generate unique 6-digit ID with DB check
const generateUniqueOrderId = async () => {
  let newId;
  let exists = true;

  while (exists) {
    newId = Math.floor(100000 + Math.random() * 900000).toString();
    exists = await Order.exists({ orderId: newId });
  }

  return newId;
};

const wooCommerceWebhookHandler = async (req, res) => {
  try {
    const orderData = req.body;
    console.log("orderData for Woo commerce", req.body);

    // Extract store URL from body or header
    const storeURL = orderData.store_url || req.headers["x-wc-webhook-source"];
    console.log("req headers", req.headers["x-wc-webhook-source"]);
    if (!storeURL) {
      return res.status(400).json({ error: "Missing store URL in webhook" });
    }

    // Find store in DB
    const store = await AllChannel.findOne({ storeURL });
    if (!store) {
      return res.status(404).json({ error: "Store not found" });
    }

    // Product details + weight/dimensions aggregation
    let totalWeight = 0.5;
    let totalLength = 10,
      totalWidth = 10,
      totalHeight = 10;

    const productDetails = await Promise.all(
      (orderData.line_items || []).map(async (item) => {
        const productInfo = await getWooCommerceProductDetails(
          item.product_id,
          storeURL,
          store.storeClientId, // consumerKey
          store.storeClientSecret // consumerSecret
        );

        totalWeight +=
          (parseFloat(productInfo.weight) || 0) * (item.quantity || 0);
        totalLength = Math.max(
          totalLength,
          parseFloat(productInfo.length) || 10
        );
        totalWidth = Math.max(totalWidth, parseFloat(productInfo.width) || 10);
        totalHeight = Math.max(
          totalHeight,
          parseFloat(productInfo.height) || 10
        );

        return {
          id: item?.id,
          quantity: item?.quantity,
          name: item?.name,
          sku: item?.sku,
          unitPrice: String(item.price), // always string
        };
      })
    );

    // Our internal unique orderId
    const internalOrderId = await generateUniqueOrderId();
    // Composite ID uses WC's own orderId
    const compositeOrderId = `${store.userId}-${internalOrderId}`;
    // Map payment details
    const paymentMethod = mapWCPayment(
      orderData.payment_method,
      orderData.payment_method_title
    );
    const paymentDetails = {
      method: paymentMethod,
      amount: parseFloat(orderData.total) || 0,
    };

    // Prepare order payload
    const orderPayload = {
      userId: store.userId, // from the store record
      orderId: internalOrderId, // our own 6-digit ID
      compositeOrderId, // customer_id + WC orderId
      channelId: orderData.id,
      channel: "WooCommerce",
      storeUrl: storeURL,
      pickupAddress: {
        contactName: "Default Name",
        email: "default@email.com",
        phoneNumber: "9999999999",
        address: "Default Warehouse Address",
        pinCode: "000000",
        city: "Default City",
        state: "Default State",
      },
      receiverAddress: {
        contactName: `${orderData.shipping.first_name} ${orderData.shipping.last_name}`,
        email: orderData.billing.email,
        phoneNumber: orderData.shipping.phone || orderData.billing.phone,
        address: orderData.shipping.address_1,
        pinCode: orderData.shipping.postcode,
        city: orderData.shipping.city,
        state: orderData.shipping.state,
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
      paymentDetails,
      status: "new",
    };

    try {
      await Order.create(orderPayload);
      return res
        .status(200)
        .json({ message: "WooCommerce order synced successfully." });
    } catch (err) {
      if (err.code === 11000) {
        return res
          .status(200)
          .json({ message: "Duplicate: WooCommerce order already synced." });
      }
      throw err;
    }
  } catch (error) {
    console.error("Error syncing WooCommerce order:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
};

//product details

const getWooCommerceProductDetails = async (
  productId,
  storeURL,
  consumerKey,
  consumerSecret
) => {
  try {
    // Ensure no trailing slash in store URL
    const baseUrl = storeURL.replace(/\/$/, "");

    const response = await axios.get(
      `${baseUrl}/wp-json/wc/v3/products/${productId}`,
      {
        auth: {
          username: consumerKey,
          password: consumerSecret,
        },
      }
    );

    const product = response.data || {};
    console.log("product", response.data);
    const dimensions = product.dimensions || {};
    console.log("dimensions", dimensions);

    return {
      weight: parseFloat(product.weight) || 0.5,
      length: parseFloat(dimensions.length) || 10,
      width: parseFloat(dimensions.width) || 10,
      height: parseFloat(dimensions.height) || 10,
      sku: product.sku || null, // Optional extra
      price: product.price ? parseFloat(product.price) : null, // Optional extra
    };
  } catch (error) {
    console.error(
      "Error fetching WooCommerce product details:",
      error.response?.data || error.message || error
    );
    return { weight: 0, length: 10, width: 10, height: 10 };
  }
};

const markWooOrderAsShipped = async (
  storeUrl,
  orderId,
  trackingNumber,
  courierName
) => {
  try {
    const baseUrl = storeUrl.replace(/\/$/, "");
    console.log("baseUrl", baseUrl);
    const store = await AllChannel.findOne({ storeURL: storeUrl });
    const trackingUrl = `https://app.shipexindia.com/dashboard/order/tracking/${trackingNumber}`;
    // 1. Update WooCommerce order status to "completed"
    await axios.put(
      `${baseUrl}/wp-json/wc/v3/orders/${orderId}`,
      { status: "completed" },
      {
        auth: {
          username: store.storeClientId,
          password: store.storeClientSecret,
        },
      }
    );

    console.log(`✅ WooCommerce order ${orderId} marked as completed`);

    // 2. (Optional) Add tracking info if shipment tracking plugin is installed
    if (trackingNumber) {
      try {
        await axios.post(
          `${baseUrl}/wp-json/wc-shipment-tracking/v3/orders/${orderId}/shipment-trackings`,
          {
            tracking_provider: courierName || "Custom Provider",
            tracking_number: trackingNumber,
            date_shipped: new Date().toISOString(),
            tracking_url: trackingUrl || "",
          },
          {
            auth: {
              username: consumerKey,
              password: consumerSecret,
            },
          }
        );
        console.log(`🚚 Tracking info added for WooCommerce order ${orderId}`);
      } catch (err) {
        console.log(
          `⚠️ Could not add tracking info: ${err.response?.data || err.message}`
        );
      }
    }
  } catch (error) {
    console.error(
      `❌ Error fulfilling WooCommerce order ${orderId}:`,
      error.response?.data || error.message
    );
  }
};

module.exports = { 
  markWooOrderAsShipped, 
  wooCommerceWebhookHandler, 
  createWooCommerceWebhook 
};
