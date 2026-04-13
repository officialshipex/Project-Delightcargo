const Order = require("../models/newOrder.model");
const {
  sendWhatsAppMessage,
  sendEmailMessage,
  sendSMSMessage,
} = require("../notification/notification.controller");

const EKART_WEBHOOK_TOKEN = process.env.EKART_WEBHOOK_TOKEN;

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

const ekartEpochToISTDate = (epoch) => {
  if (!epoch) return new Date();
  return new Date(epoch + IST_OFFSET_MS);
};

const EkartWebhook = async (req, res) => {
  try {
    console.log("Ekart Webhook Received:", req.body);

    const body = req.body;

    const {
      status,
      location,
      desc,
      attempts,
      wbn, // AWB number
      edd,
      ctime,
    } = body;

    if (!wbn) {
      return res.status(400).json({
        success: false,
        message: "AWB Number missing from Ekart webhook payload",
      });
    }

    // Fetch order
    const order = await Order.findOne({ awb_number: wbn });

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    const oldStatus = order.status; // 🔹 Capture status before webhook updates

    if (["new", "Cancelled"].includes(order.status)) {
      console.log(
        `Skipping Ekart Webhook for AWB ${wbn} because order status is "${order.status}"`,
      );
      return res.status(200).send("Ignored (Order Not Yet Shipped)");
    }

    // Normalize Ekart data (same structure as Shree Maruti)
    const normalizedData = {
      Status: status,
      Instructions: desc,
      StrRemarks: desc,
      StatusDateTime: ekartEpochToISTDate(ctime),
    };

    const currentStatus = normalizedData.Status;

    /* ========================================================
       ==============   FORWARD FLOW HANDLING   ===============
       ======================================================== */

    if (currentStatus === "Picked Up") {
      order.status = "In-transit";
      order.ndrStatus = "In-transit";
      if (!order.invoiceDate) {
        order.invoiceDate = normalizedData.StatusDateTime;
      }
      order.reattempt = false;
    }

    if (currentStatus === "In Transit" || currentStatus === "Reached Hub") {
      order.status = "In-transit";
      order.ndrStatus = "In-transit";
      order.reattempt = false;
    }

    if (currentStatus === "Out for Delivery") {
      order.status = "Out for Delivery";
      order.ndrStatus = "Out for Delivery";
      order.reattempt = false;
    }

    /* ========================================================
         DELIVERED LOGIC
    ======================================================== */
    if (currentStatus === "Delivered") {
      order.status = "Delivered";

      if (order.ndrHistory.length > 0) {
        order.ndrStatus = "Delivered";
        order.reattempt = true;
      } else {
        order.ndrStatus = "";
        order.reattempt = false;
      }
    }

    /* ========================================================
         RTO LOGIC
    ======================================================== */
    if (currentStatus === "RTO" || currentStatus === "RTO Requested") {
      order.status = "RTO";
      order.ndrStatus = "RTO";
      order.reattempt = false;
    }


    if (currentStatus === "RTO In Transit") {
      order.status = "RTO In-transit";
      order.ndrStatus = "RTO In-transit";
      order.reattempt = false;
    }

    if (currentStatus === "RTO Delivered") {
      order.status = "RTO Delivered";
      order.ndrStatus = "RTO Delivered";
      order.reattempt = false;
    }


    /* ========================================================
         UNDELIVERED → NDR LOGIC
    ======================================================== */
    if (currentStatus === "Undelivered") {
      order.status = "Undelivered";
      order.ndrStatus = "Undelivered";

      const currentDate = normalizedData.StatusDateTime.getTime();

      // last NDR date
      let lastNdrDate = null;
      if (order.ndrHistory.length > 0) {
        const lastHistory = order.ndrHistory[order.ndrHistory.length - 1];
        const lastAction = lastHistory.actions[lastHistory.actions.length - 1];
        lastNdrDate = new Date(lastAction.date).getTime();
      }

      const attemptCount = order.ndrHistory.length + 1;

      // store NDR reason
      order.ndrReason = {
        date: normalizedData.StatusDateTime,
        reason: normalizedData.StrRemarks,
      };

      /* ───────────────────────────────────────────────
         BLOCK DUPLICATE / OLDER NDR
      ─────────────────────────────────────────────── */
      if (
        order.ndrStatus === "Action_Requested" &&
        lastNdrDate &&
        currentDate <= lastNdrDate
      ) {
        console.log("NDR IGNORE: Duplicate or older Ekart UNDELIVERED");

        order.tracking.push({
          Instructions: normalizedData.Instructions,
          Status: normalizedData.Status,
          StatusDateTime: normalizedData.StatusDateTime,
          StatusLocation: location || "Unknown",
        });

        await order.save();
        return res.status(200).json({
          success: true,
          message: "Webhook processed (ignored duplicate NDR)",
        });
      }

      /* ───────────────────────────────────────────────
         VALID NDR CASE
      ─────────────────────────────────────────────── */
      if (!lastNdrDate || currentDate > lastNdrDate) {
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

    /* ========================================================
       ===============   SAVE TRACKING ENTRY   ================
       ======================================================== */
    order.tracking.push({
      Instructions: normalizedData.Instructions,
      Status: normalizedData.Status,
      StatusDateTime: normalizedData.StatusDateTime,
      StatusLocation: location || "Unknown",
    });

    await order.save();

    // 🔹 Trigger Notifications if status changed via Webhook
    if (order.status !== oldStatus) {
      console.log(`🔔 Webhook: Status changed from ${oldStatus} to ${order.status}. Sending notifications...`);
      
      const notificationData = {
        userId: order.userId,
        awb_number: order.awb_number,
        status: order.status,
        date: new Date(),
        mobile_number: order.receiverAddress?.phoneNumber, // 🔹 Corrected key
        email: order.receiverAddress?.email,              // 🔹 Corrected key
        
        
        
      };

      // Fire and forget - failures won't stop the webhook processing
      (async () => {
        try {
          await Promise.allSettled([
            sendWhatsAppMessage(notificationData),
            sendEmailMessage(notificationData),
            sendSMSMessage(notificationData)
          ]);
        } catch (e) {
          console.error("Ekart Webhook Notification Error:", e.message);
        }
      })();
    }

    return res.status(200).json({
      success: true,
      message: "Ekart webhook processed successfully",
    });
  } catch (error) {
    console.error("Ekart Webhook Error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

module.exports = { EkartWebhook };
