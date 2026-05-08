const Order = require("../models/newOrder.model");
const Wallet = require("../models/wallet");
const User = require("../models/User.model");
const { formatShreeMarutiDate } = require("../Orders/tracking.controller");
const {
  sendWhatsAppMessage,
  sendEmailMessage,
  sendSMSMessage,
} = require("../notification/notification.controller");

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

    // ------------------------------------------------
    // DUPLICATE TRACKING CHECK (More robust)
    // ------------------------------------------------
    const isDuplicate = order.tracking.some(
      (t) =>
        t.StatusDateTime &&
        new Date(t.StatusDateTime).getTime() ===
        new Date(normalizedData.StatusDateTime).getTime() &&
        t.Instructions === normalizedData.Instructions
    );

    if (isDuplicate) {
      console.log(`Duplicate tracking entry for AWB ${awb} at ${normalizedData.StatusDateTime}. Skipping update.`);
      return res.status(200).json({
        success: true,
        message: "Duplicate tracking entry, update skipped",
      });
    }

    const status = normalizedData.Status;

    /* ────────────────────────────────────────────────
       CHECK IF STATUS IS RTO STATUS
    ───────────────────────────────────────────────── */
    const isRTOStatus = [
      "RTO",
      "RTO_REQUESTED",
      "RTO_OUT_FOR_DELIVERY",
      "RTO_IN_TRANSIT",
      "RTO_DELIVERED",
    ].includes(status);

    /* ========================================================
       ================   RTO FLOW HANDLING   ================
       ======================================================== */
    if (isRTOStatus) {
      order.reattempt = false; // not NDR case, this is RTO

      if (status === "RTO" || status === "RTO_REQUESTED") {
        order.status = "RTO";
        order.ndrStatus = "RTO";
      } else if (status === "RTO_OUT_FOR_DELIVERY" || status === "RTO_IN_TRANSIT") {
        order.status = "RTO In-transit";
        order.ndrStatus = "RTO In-transit";
      } else if (status === "RTO_DELIVERED") {
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

      const isPickupCancelled =
        status === "CANCELLED" ||
        status === "PICKUP_CANCELLED" ||
        normalizedData.Instructions?.toLowerCase() === "pickup cancelled" ||
        normalizedData.Instructions?.toLowerCase() === "pickup_cancelled";

      if (isPickupCancelled) {
        order.status = "Cancelled";
        order.ndrStatus = "Cancelled";

        const balanceToBeAdded =
          order.totalFreightCharges === "N/A" || !order.totalFreightCharges
            ? 0
            : parseFloat(order.totalFreightCharges);

        if (balanceToBeAdded > 0 && !order.walletRefunded) {
          const userDoc = await User.findById(order.userId);
          if (userDoc) {
            const currentWallet = await Wallet.findById(userDoc.Wallet);
            if (currentWallet) {
              const alreadyRefunded = currentWallet.transactions.some(
                (t) =>
                  t.awb_number === order.awb_number &&
                  t.category === "credit" &&
                  (t.description === "Freight Charges Received" ||
                    t.description === "Freight Charges Refunded")
              );

              if (!alreadyRefunded) {
                const newBalance = (currentWallet.balance || 0) + balanceToBeAdded;
                await Wallet.findOneAndUpdate(
                  { _id: currentWallet._id },
                  {
                    $inc: { balance: balanceToBeAdded },
                    $push: {
                      transactions: {
                        channelOrderId: order.orderId || null,
                        category: "credit",
                        amount: balanceToBeAdded,
                        balanceAfterTransaction: newBalance,
                        date: new Date(),
                        awb_number: order.awb_number,
                        description: "Freight Charges Received",
                      },
                    },
                  }
                );
                order.walletRefunded = true;
                console.log(
                  `Refunded ${balanceToBeAdded} for AWB ${order.awb_number} due to pickup cancellation`
                );
              }
            }
          }
        }
      }

      if (status === "PICKED_UP" || status === "PICKEDUP") {
        order.status = "In-transit";
        order.ndrStatus = "In-transit";
        if (!order.invoiceDate) {
          order.invoiceDate = normalizedData.StatusDateTime
        }
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
        const currentDate = new Date(normalizedData.StatusDateTime).getTime();

        // fetch last NDR attempt date (if any)
        let lastNdrDate = null;
        if (order.ndrHistory.length > 0) {
          const lastHistory = order.ndrHistory[order.ndrHistory.length - 1];
          const lastAction =
            lastHistory.actions[lastHistory.actions.length - 1];
          lastNdrDate = new Date(lastAction.date).getTime();
        }

        // store reason always
        order.ndrReason = {
          date: normalizedData.StatusDateTime,
          reason: normalizedData.StrRemarks,
        };

        /* 
          ───────────────────────────────────────────────
          VALID NDR CASE:
          Only if:
          - ndrStatus is NOT Action_Requested (or it's a newer update)
          - currentDate > lastNdrDate
          - attemptCount <= 2
          ───────────────────────────────────────────────
        */
        if (!lastNdrDate || currentDate > lastNdrDate) {
          const attemptCount = order.ndrHistory.length + 1;
          if (attemptCount <= 3) { // Limit to 3 NDR attempts as per business logic
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
        } else {
          console.log("NDR IGNORE: Duplicate or older UNDELIVERED update based on date.");
        }
      }
    }

    /* ========================================================
       ===============   SAVE TRACKING ENTRY   ================
       ======================================================== */
    order.tracking.push({
      Instructions: normalizedData.Instructions,
      status: normalizedData.Status, // 🔹 Use lowercase 'status' to match schema
      StatusDateTime: normalizedData.StatusDateTime,
      StatusLocation: data.location || "Unknown",
    });

    await order.save();

    // 🔔 Trigger Notifications (unconditional — MessageLog handles dedup per awb+status)
    if (order.status) {
      console.log(`🔔 Shree Maruti Webhook: Sending notifications for AWB ${awb}, status: ${order.status}`);

      const notificationData = {
        userId: order.userId,
        awb_number: order.awb_number,
        status: order.status,
        date: new Date(),
        mobile_number: order.receiverAddress?.phoneNumber,
        email: order.receiverAddress?.email,
      };

      (async () => {
        try {
          await Promise.allSettled([
            sendWhatsAppMessage(notificationData),
            sendEmailMessage(notificationData),
            sendSMSMessage(notificationData)
          ]);
        } catch (e) {
          console.error("Shree Maruti Webhook Notification Error:", e.message);
        }
      })();

      // Sync to WooCommerce if applicable
      if (order.channel === "WooCommerce") {
        (async () => {
          try {
            const AllChannelModel = require("../Channels/allChannel.model");
            const { markWooOrderAsShipped } = require("../Channels/WooCommerce/woocommerce.controller");
            const store = await AllChannelModel.findOne({ userId: order.userId, channel: "WooCommerce" });
            if (store?.storeURL) {
              await markWooOrderAsShipped(store.storeURL, order.orderId, order.awb_number, order.provider, order.status);
            }
          } catch (e) {
            console.error(`⚠️ WooCommerce sync failed for AWB ${order.awb_number}:`, e.message);
          }
        })();
      }
    }

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
