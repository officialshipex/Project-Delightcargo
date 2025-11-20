const Order = require("../models/newOrder.model");
const AMAZON_SHIPPING_WEBHOOK_TOKEN = process.env.AMAZON_SHIPPING_WEBHOOK_TOKEN;
const {
  updateNdrHistoryByAwb,
  formatAmazonDate,
} = require("../Orders/tracking.controller");

const AmazonShippingWebhook = async (req, res) => {
  try {
    const token = req.headers.authorization;
    console.log("Amazon Webhook Token:", token);
    if (token !== AMAZON_SHIPPING_WEBHOOK_TOKEN) {
      return res.status(401).send("Unauthorized");
    }
    console.log("Amazon Webhook Payload Received:", req.body);
    const payload = req.body?.payload;

    if (!payload) return res.status(400).send("Invalid payload");

    const trackingId = payload.trackingId || payload.alternateLegTrackingId;
    if (!trackingId) return res.status(400).send("Missing tracking ID");

    const order = await Order.findOne({ awb_number: trackingId });
    if (!order) return res.status(404).send("Order not found");

    const events = payload.eventHistory || [];
    if (!events.length) return res.status(400).send("No events found");

    // Latest Event
    const latestEvent = events[events.length - 1];
    const eventCode = latestEvent.eventCode;
    const eventTime = formatAmazonDate(latestEvent.eventTime);
    const shipmentType = latestEvent.shipmentType; // FORWARD / RETURNS

    console.log("Processing Amazon Webhook:", {
      trackingId,
      eventCode,
      shipmentType,
    });

    // ---------------------------
    // FORWARD FLOW
    // ---------------------------

    if (shipmentType === "FORWARD") {
      if (eventCode === "ReadyForReceive") {
        order.status = "Ready To Ship";
      }

      if (
        eventCode === "PickupDone" ||
        eventCode === "ArrivedAtCarrierFacility" ||
        eventCode === "Departed" ||
        eventCode === "InTransit"
      ) {
        order.status = "In-transit";
        order.reattempt = false;
      }

      if (eventCode === "OutForDelivery") {
        order.status = "Out for Delivery";
        order.ndrStatus = "Out for Delivery";
        order.reattempt = false;
      }

      if (eventCode === "Delivered") {
        order.status = "Delivered";

        // If at least 1 NDR happened before → NDR Delivered
        if (order.ndrHistory && order.ndrHistory.length > 0) {
          order.ndrStatus = "Delivered";
        } else {
          // No NDR → Keep ndrStatus empty
          order.ndrStatus = null;
        }

        order.reattempt = false;
      }

      // --------------- NDR / FAILED DELIVERY ---------------
      if (eventCode === "Rejected" || eventCode === "Undeliverable") {
        order.status = "Undelivered";
        order.ndrStatus = "Undelivered";
        order.reattempt = true;

        const reason =
          payload?.summary?.trackingDetailCodes?.forward?.join(", ") ||
          eventCode;

        order.ndrReason = {
          date: eventTime,
          reason,
        };

        updateNdrHistoryByAwb(order.awb_number);
      }
    }

    // ---------------------------
    // RETURNS / RTO FLOW
    // ---------------------------
    if (shipmentType === "RETURNS") {
      if (eventCode === "ReturnInitiated") {
        order.status = "RTO In-transit";
        order.ndrStatus = "RTO In-transit";
        order.reattempt = false;
      }

      if (
        eventCode === "ArrivedAtCarrierFacility" ||
        eventCode === "Departed"
      ) {
        order.status = "RTO In-transit";
        order.ndrStatus = "RTO In-transit";
        order.reattempt = false;
      }

      if (eventCode === "Delivered") {
        order.status = "RTO Delivered";
        order.ndrStatus = "RTO Delivered";
        order.reattempt = false;
      }

      if (eventCode === "Undeliverable") {
        order.status = "RTO In-transit";
        order.ndrStatus = "RTO In-transit";
        order.reattempt = false;
      }
    }

    // ---------------------------
    // TRACKING ARRAY UPDATE
    // Only: Status, Instruction, Date, Location
    // ---------------------------

    order.tracking.push({
      Status: order.status,
      Instructions: eventCode,
      StatusDateTime: eventTime,
      StatusLocation: formatAmazonLocation(latestEvent.location),
    });

    await order.save();

    return res.status(200).send("Webhook processed successfully");
  } catch (error) {
    console.error("Amazon Webhook Error:", error);
    return res.status(500).send("Internal Server Error");
  }
};

function formatAmazonLocation(location = {}) {
  const { city, stateOrRegion, postalCode, countryCode } = location;

  return [city, stateOrRegion, postalCode, countryCode]
    .filter(Boolean) // remove undefined/empty
    .join(", "); // join into 1 line string
}

module.exports = { AmazonShippingWebhook };
