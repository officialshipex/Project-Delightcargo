const Order = require("../models/newOrder.model");
const { formatShreeMarutiDate } = require("../Orders/tracking.controller");

const ShreeMarutiWebhook = async (req, res) => {
  try {
    const body = req.body;
    console.log("Shree Maruti Webhook Received:", body);

    const event = body.event;
    const data = body.data || {};

    const awb = data.awbNumber;

    if (!awb) {
      return res.status(400).json({
        success: false,
        message: "AWB Number missing from webhook payload",
      });
    }

    // Fetch Order
    const order = await Order.findOne({ awb_number: awb });

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    // Normalize
    const normalizedData = {
      Status: data.orderStatus || event,
      Instructions: event,
      StrRemarks: data.remarks || null,
      StatusDateTime: formatShreeMarutiDate(data.statusUpdatedAt) || new Date(),
    };

    console.log("Normalized Webhook Data:", normalizedData);

    const status = normalizedData.Status;

    /* ────────────────────────────────────────────────
       CHECK IF STATUS IS RTO STATUS
    ───────────────────────────────────────────────── */
    const isRTOStatus = [
      "RTO",
      "RTO_OUT_FOR_DELIVERY",
      "RTO_IN_TRANSIT",
      "RTO_DELIVERED",
    ].includes(status);

    /* ========================================================
       ================   RTO FLOW HANDLING   ================
       ======================================================== */
    if (isRTOStatus) {
      order.reattempt = false; // not NDR case, this is RTO

      if (status === "RTO") {
        order.status = "RTO";
        order.ndrStatus = "RTO";
      }

      if (status === "RTO_OUT_FOR_DELIVERY") {
        order.status = "RTO In-transit";
        order.ndrStatus = "RTO In-transit";
      }

      if (status === "RTO_IN_TRANSIT") {
        order.status = "RTO In-transit";
        order.ndrStatus = "RTO In-transit";
      }

      if (status === "RTO_DELIVERED") {
        order.status = "RTO Delivered";
        order.ndrStatus = "RTO Delivered";
      }
    }

    /* ========================================================
       ==============   FORWARD FLOW HANDLING   ===============
       ======================================================== */
    else {
      if (status === "NEW") order.status = "Booked";

      if (status === "NOT_PICKED_UP") order.status = "Not Picked";

      if (status === "READY_FOR_DISPATCH") order.status = "Ready To Ship";

      if (status === "PICKED_UP") order.status = "In-transit";

      if (status === "IN_PROCESS" || status === "IN_TRANSIT")
        order.status = "In-transit";

      if (status === "OUT_FOR_DELIVERY" || status === "READY_FOR_DELIVERY") {
        order.status = "Out for Delivery";
        order.ndrStatus = "Out for Delivery";
      }

      /* ========================================================
         DELIVERED LOGIC
      ======================================================== */
      if (status === "DELIVERED") {
        order.status = "Delivered";

        if (order.ndrHistory.length > 0) {
          order.ndrStatus = "Delivered";
          order.reattempt = true;
        } else {
          order.ndrStatus = ""; // No NDR happened
          order.reattempt = false;
        }
      }

      if (status === "LOST") order.status = "Lost";

      if (status === "ON_HOLD") order.status = "In-transit";

      /* ========================================================
         UNDELIVERED → NDR LOGIC
      ======================================================== */
      if (status === "UNDELIVERED") {
        order.status = "Undelivered";
        order.ndrStatus = "Undelivered";
        order.reattempt = true;

        const attemptCount = order.ndrHistory.length + 1;

        // avoid duplicate entry for same day
        const alreadyExists = order.ndrHistory.some((h) => {
          const lastAction = h.actions[h.actions.length - 1];
          return (
            new Date(lastAction.date).toDateString() ===
            new Date(normalizedData.StatusDateTime).toDateString()
          );
        });

        if (!alreadyExists && attemptCount <= 2) {
          order.ndrHistory.push({
            actions: [
              {
                action: `NDR ${attemptCount} Raised`,
                actionBy: order.courierServiceName,
                remark: normalizedData.StrRemarks,
                source: order.provider,
                date: normalizedData.StatusDateTime,
              },
            ],
          });
        }
      }
    }

    /* ========================================================
       ===============   SAVE TRACKING ENTRY   ================
       ======================================================== */
    order.tracking.push({
      Instructions: normalizedData.Instructions,
      Status: normalizedData.Status,
      StatusDateTime: normalizedData.StatusDateTime,
      StatusLocation: data.location || "Unknown",
    });

    await order.save();

    return res.status(200).json({
      success: true,
      message: "Webhook processed successfully",
    });
  } catch (error) {
    console.error("Shree Maruti Webhook Error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

module.exports = { ShreeMarutiWebhook };
