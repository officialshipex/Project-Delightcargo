const AMAZON_SHIPPING_WEBHOOK_TOKEN = process.env.AMAZON_SHIPPING_WEBHOOK_TOKEN;
const Order=require("../../models/newOrder.model")
const {formatAmazonDate}=require("../../Orders/tracking.controller")

const AmazonShippingNDRWebhook = async (req, res) => {
  try {
    const token = req.headers.authorization;

    if (token !== AMAZON_SHIPPING_WEBHOOK_TOKEN) {
      return res.status(401).send("Unauthorized");
    }

    console.log("📩 Amazon NDR Webhook Received:", req.body);

    const payload = req.body.detail;

    const trackingId = payload.trackingId;
    const status = payload.shipmentStatus; // “Undeliverable”
    const reason = payload.reasonCode; // “Customer rejected”
    const latestAttemptDate = formatAmazonDate(payload.latestDeliveryAttemptedDate);
    const attemptCount = Number(payload.deliveryAttemptCount || 1);

    // Find Order
    const order = await Order.findOne({
      awb_number: trackingId,
      provider: "Amazon Shipping"
    });

    if (!order) {
      console.log("⚠ No order found for Amazon NDR trackingId:", trackingId);
      return res.status(200).send("Order not found");
    }

    // --- Update NDR state ---
    order.status = "Undelivered";
    order.ndrStatus = "Undelivered";
    order.reattempt = true;

    order.ndrReason = {
      date: latestAttemptDate,
      reason,
    };

    // --- Update NDR History (prevent duplicate same date updates) ---
    const lastNdr = order.ndrHistory[order.ndrHistory.length - 1];
    const lastAction = lastNdr?.actions?.[lastNdr.actions.length - 1];
    const lastEntryDate = lastAction?.date
      ? new Date(lastAction.date).getTime()
      : null;

    const currentStatusDate = new Date(latestAttemptDate).getTime();

    // Only push new NDR entry if different timestamp
    if (lastEntryDate !== currentStatusDate) {
      const newEntry = {
        actions: [
          {
            action: `NDR ${attemptCount} Raised`,
            actionBy: "Amazon Shipping",
            remark: reason,
            source: "Amazon Shipping",
            date: latestAttemptDate,
          },
        ],
      };

      order.ndrHistory.push(newEntry);
    }

    await order.save();

    console.log("✅ Amazon NDR Updated:", order.orderId);

    return res.status(200).send("OK");
  } catch (error) {
    console.error("❌ Amazon NDR Webhook Error:", error);
    return res.status(500).send("Internal Error");
  }
};

module.exports = { AmazonShippingNDRWebhook };
