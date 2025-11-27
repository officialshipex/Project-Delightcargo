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

    if (["new", "Cancelled"].includes(order.status)) {
      console.log(
        `Skipping Shree Maruti Webhook for AWB ${awb} because order status is "${order.status}"`
      );
      return res.status(200).send("Ignored (Order Not Yet Shipped)");
    }

    // Normalize
    const normalizedData = {
      Status: event,
      Instructions: data.orderStatus,
      StrRemarks: data.remarks || data.reason,
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
    } else {
      /* ========================================================
       ==============   FORWARD FLOW HANDLING   ===============
       ======================================================== */
      if (status === "NEW") order.status = "Booked";

      if (status === "NOT_PICKED_UP") order.status = "Not Picked";

      if (status === "READY_FOR_DISPATCH") order.status = "Ready To Ship";

      if (status === "PICKED_UP") {
        order.status = "In-transit";
        order.ndrStatus = "In-transit";
        order.reattempt = false;
      }

      if (status === "IN_PROCESS" || status === "IN_TRANSIT") {
        order.status = "In-transit";
        order.ndrStatus = "In-transit";
        order.reattempt = false;
      }
      if (status === "OUT_FOR_DELIVERY" || status === "READY_FOR_DELIVERY") {
        order.status = "Out for Delivery";
        order.ndrStatus = "Out for Delivery";
        order.reattempt = false;
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
        const currentDate = new Date(normalizedData.StatusDateTime);

        // fetch last NDR attempt date (if any)
        let lastNdrDate = null;
        if (order.ndrHistory.length > 0) {
          const lastHistory = order.ndrHistory[order.ndrHistory.length - 1];
          const lastAction =
            lastHistory.actions[lastHistory.actions.length - 1];
          lastNdrDate = new Date(lastAction.date);
        }

        const attemptCount = order.ndrHistory.length + 1;

        // store reason always
        order.ndrReason = {
          date: normalizedData.StatusDateTime,
          reason: normalizedData.StrRemarks,
        };

        /* 
    ───────────────────────────────────────────────
    BLOCK WRONG NDR UPDATES:
    If NDR was already raised → ndrStatus = Action_Requested
    And new event is same or older → ignore
    ───────────────────────────────────────────────
  */
        if (
          order.ndrStatus === "Action_Requested" &&
          lastNdrDate &&
          currentDate <= lastNdrDate
        ) {
          console.log("NDR IGNORE: Duplicate or older UNDELIVERED update");

          // do NOT change ndrStatus
          // do NOT set reattempt true
          // do NOT push NDR history again

          // only save tracking
          order.tracking.push({
            Instructions: normalizedData.Instructions,
            Status: normalizedData.Status,
            StatusDateTime: normalizedData.StatusDateTime,
            StatusLocation: data.location || "Unknown",
          });
          await order.save();
          return res.status(200).json({
            success: true,
            message: "Webhook processed (ignored duplicate NDR)",
          });
        }

        /*
    ───────────────────────────────────────────────
    VALID NDR CASE:
    Only if:
    - ndrStatus is NOT Action_Requested
    - currentDate > lastNdrDate
    - attemptCount <= 2
    ───────────────────────────────────────────────
  */

        if (attemptCount <= 2 && (!lastNdrDate || currentDate > lastNdrDate)) {
          order.reattempt = true;

          order.ndrHistory.push({
            actions: [
              {
                action: `NDR ${attemptCount} Raised`,
                actionBy: order.provider,
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
