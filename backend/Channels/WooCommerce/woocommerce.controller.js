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
          store.storeClientId,
          store.storeClientSecret
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

        const total = parseFloat(item.total) || 0;
        const totalTax = parseFloat(item.total_tax) || 0;
        const subtotal = parseFloat(item.subtotal) || 0;
        const subtotalTax = parseFloat(item.subtotal_tax) || 0;
        const qty = parseInt(item.quantity) || 1;

        // Calculate inclusive unit price (using subtotal to get the original price before discounts)
        const unitPriceInclTax = (subtotal + subtotalTax) / qty;
        
        // Calculate discount per unit (if any)
        const discountInclTax = (subtotal + subtotalTax - total - totalTax) / qty;

        const productRow = {
          id: item.product_id,
          quantity: qty,
          name: item.name,
          unitPrice: unitPriceInclTax.toFixed(2),
          discount: discountInclTax > 0 ? discountInclTax.toFixed(2) : "0",
          sku: item.sku,
          tax: String(totalTax),
        };

        console.log(`Synced Product: ${item.name} | UnitPrice(Incl.Tax): ${productRow.unitPrice} | Discount: ${productRow.discount}`);
        return productRow;
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

// Map Shipex internal status → WooCommerce order status
// WooCommerce standard: pending, processing, on-hold, completed, cancelled
// Stores with shipment plugins may also accept: shipped, in-transit, out-for-delivery, etc.
const shipexToWooStatus = (shipexStatus) => {
  const map = {
    "Booked":           "processing",    // Courier booked, order being shipped
    "Ready To Ship":    "processing",    // Ready for pickup
    "Pickup Completed": "processing",    // Picked up by courier
    "In-transit":       "on-hold",       // In transit (no native WC status; on-hold = awaiting shipment)
    "Out for Delivery": "on-hold",       // Out for delivery
    "Delivered":        "completed",     // Successfully delivered
    "Cancelled":        "cancelled",     // Order cancelled
    "RTO":              "on-hold",       // Return to origin initiated
    "RTO In-transit":   "on-hold",       // Returning to origin
    "RTO Delivered":    "on-hold",       // Returned to origin
    "Undelivered":      "on-hold",       // Delivery attempt failed
    "Lost":             "on-hold",       // Shipment lost
  };
  return map[shipexStatus] || null; // null = don't update WC status for unknown statuses
};

const markWooOrderAsShipped = async (
  storeUrl,
  orderId,
  trackingNumber,
  courierName,
  shipexStatus   // Shipex order status (e.g. "In-transit", "Delivered", "Booked")
) => {
  try {
    const baseUrl = storeUrl.replace(/\/$/, "");
    const store = await AllChannel.findOne({ 
      storeURL: { $regex: storeUrl.replace(/\/$/, ""), $options: "i" } 
    });

    if (!store) {
      console.error(`❌ Store not found for URL: ${storeUrl}`);
      return;
    }

    // 1. Resolve channelId (WC's internal ID) if our internal 6-digit ID was provided
    let wcOrderId = orderId;
    const dbOrder = await Order.findOne({ 
      $or: [{ orderId: orderId }, { channelId: orderId }] 
    });
    
    if (dbOrder && dbOrder.channel !== "WooCommerce") {
      console.error(`❌ Order ${orderId} is a ${dbOrder.channel} order, not a WooCommerce order. Fulfillment skipped.`);
      return;
    }

    if (dbOrder && dbOrder.channelId) {
      wcOrderId = dbOrder.channelId;
      console.log(`ℹ️ Resolved internal ID ${orderId} to WooCommerce ID ${wcOrderId}`);
    }

    // 2. Map Shipex status → WooCommerce status
    const wcStatus = shipexToWooStatus(shipexStatus);
    if (!wcStatus) {
      console.log(`ℹ️ No WooCommerce status mapping for Shipex status: "${shipexStatus}". Skipping WC update.`);
      return;
    }

    const trackingUrl = `https://app.shipexindia.com/dashboard/order/tracking/${trackingNumber}`;

    // 3. Update WooCommerce order status
    await axios.put(
      `${baseUrl}/wp-json/wc/v3/orders/${wcOrderId}`,
      { 
        status: wcStatus,
        customer_note: `Shipex Update: ${shipexStatus} | AWB: ${trackingNumber} | Courier: ${courierName || "N/A"}`,
      },
      {
        auth: {
          username: store.storeClientId,
          password: store.storeClientSecret,
        },
      }
    );

    console.log(`✅ WooCommerce order ${wcOrderId} status updated: ${shipexStatus} → ${wcStatus}`);

    // 4. Add tracking info to WooCommerce (only when Booked / first shipment scan)
    const addTrackingStatuses = ["Booked", "Ready To Ship", "Pickup Completed"];
    if (trackingNumber && addTrackingStatuses.includes(shipexStatus)) {
      try {
        await axios.post(
          `${baseUrl}/wp-json/wc-shipment-tracking/v3/orders/${wcOrderId}/shipment-trackings`,
          {
            tracking_provider: courierName || "Custom Provider",
            tracking_number: trackingNumber,
            date_shipped: new Date().toISOString(),
            tracking_url: trackingUrl || "",
          },
          {
            auth: {
              username: store.storeClientId,
              password: store.storeClientSecret,
            },
          }
        );
        console.log(`🚚 Tracking info added for WooCommerce order ${wcOrderId}`);
      } catch (err) {
        console.log(
          `⚠️ Could not add tracking info (plugin may not be installed): ${err.response?.data?.message || err.message}`
        );
      }
    }

    // 5. Trigger Notifications to Customer (dedup handled by MessageLog in notification controller)
    const orderForNotif = dbOrder;
    if (orderForNotif && (orderForNotif.receiverAddress?.phoneNumber || orderForNotif.receiverAddress?.email)) {
      const User = require("../../models/User.model");
      const Wallet = require("../../models/wallet");
      const userWithWallet = await User.findById(orderForNotif.userId).select("Wallet");
      const wallet = userWithWallet?.Wallet ? await Wallet.findById(userWithWallet.Wallet) : null;

      const notificationData = {
        userId: orderForNotif.userId,
        awb_number: trackingNumber,
        status: shipexStatus,  // Use actual Shipex status, not hardcoded "Booked"
        date: new Date(),
        credit: wallet?.creditBalance || 0,
        mobile_number: orderForNotif.receiverAddress?.phoneNumber,
        email: orderForNotif.receiverAddress?.email,
      };

      console.log(`🔔 Sending fulfillment notifications for AWB: ${trackingNumber}, status: ${shipexStatus}`);
      
      // Fire and forget
      (async () => {
        try {
          const { sendWhatsAppMessage, sendEmailMessage, sendSMSMessage } = require("../../notification/notification.controller");
          await Promise.allSettled([
            sendWhatsAppMessage(notificationData),
            sendEmailMessage(notificationData),
            sendSMSMessage(notificationData)
          ]);
          console.log(`✅ Notifications triggered for WooCommerce order ${wcOrderId}, status: ${shipexStatus}`);
        } catch (e) {
          console.error("⚠️ Fulfillment Notification Error:", e.message);
        }
      })();
    }
  } catch (error) {
    console.error(
      `❌ Error fulfilling WooCommerce order ${orderId}:`,
      error.response?.data || error.message
    );
  }
};

// markWooOrderAsShipped("https://shop.teamworkarts.com/","576643","QPSP0000000209","Ekart")

module.exports = { 
  markWooOrderAsShipped, 
  wooCommerceWebhookHandler, 
  createWooCommerceWebhook 
};
