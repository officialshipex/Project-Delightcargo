const Order = require("../models/newOrder.model");
const Wallet = require("../models/wallet");
const User = require("../models/User.model");
const {
  sendWhatsAppMessage,
  sendEmailMessage,
  sendSMSMessage,
} = require("../notification/notification.controller");

/**
 * Shiprocket Status ID Mapping (Simplified):
 * 1  - PICKUP_SCHEDULED
 * 2  - PICKUP_ERROR
 * 3  - PICKUP_RESCHEDULED
 * 4  - PICKUP_EXCEPTION
 * 5  - OUT_FOR_PICKUP
 * 6  - PICKED_UP
 * 7  - IN_TRANSIT
 * 8  - OUT_FOR_DELIVERY
 * 9  - DELIVERED
 * 10 - CANCELLED
 * 11 - RTO_INITIATED
 * 12 - RTO_DELIVERED
 * 13 - NDR
 * 14 - DISPATCHED
 * 17 - OUT_FOR_DELIVERY (Secondary)
 * 18 - DELIVERY_BOY_ASSIGNED
 * 19 - RE-ATTEMPT_REQUESTED
 */

const ShipRocketWebhook = async (req, res) => {
  try {
    const body = req.body;
    console.log("ShipRocket Webhook Received:", JSON.stringify(body, null, 2));

    // Shiprocket sends individual shipment event
    const awb = body.awb;
    const statusId = parseInt(body.current_status_id || body.status_id);
    const statusText = body.current_status || body.status || "Unknown";
    const location = body.location || "Unknown";
    const timestamp = body.current_timestamp ? new Date(body.current_timestamp) : new Date();
    const remark = body.activity || statusText;

    if (!awb) {
      console.warn("ShipRocket Webhook: Missing AWB, skipping event.");
      return res.status(200).json({ success: false, message: "Missing AWB" });
    }

    // Fetch order by AWB
    const order = await Order.findOne({ awb_number: String(awb) });

    if (!order) {
      console.warn(`ShipRocket Webhook: Order not found for AWB ${awb}`);
      return res.status(200).json({ success: false, message: "Order not found" });
    }

    if (["new", "Cancelled"].includes(order.status) && statusId !== 10) {
      console.log(`ShipRocket Webhook: Skipping AWB ${awb} because order status is "${order.status}"`);
      return res.status(200).json({ success: true, message: "Order inactive" });
    }

    const oldStatus = order.status;

    // ── Duplicate Tracking Check ──
    const lastTracking = order.tracking[order.tracking.length - 1];
    if (
      lastTracking &&
      lastTracking.Instructions === remark &&
      lastTracking.StatusLocation === location &&
      new Date(lastTracking.StatusDateTime).getTime() === new Date(timestamp).getTime()
    ) {
      console.log(`ShipRocket Webhook: Duplicate tracking for AWB ${awb}, skipping.`);
      return res.status(200).json({ success: true, message: "Duplicate" });
    }

    /* ================================================================
       STATUS MAPPING
    ================================================================ */
    switch (statusId) {
      case 1: // PICKUP_SCHEDULED
      case 3: // PICKUP_RESCHEDULED
      case 5: // OUT_FOR_PICKUP
        order.status = "Booked";
        break;

      case 6: // PICKED_UP
      case 14: // DISPATCHED
        order.status = "In-transit";
        order.ndrStatus = "In-transit";
        order.reattempt = false;
        if (!order.invoiceDate) order.invoiceDate = timestamp;
        break;

      case 7: // IN_TRANSIT
        order.status = "In-transit";
        order.ndrStatus = "In-transit";
        order.reattempt = false;
        break;

      case 8: // OUT_FOR_DELIVERY
      case 17: // OUT_FOR_DELIVERY
      case 18: // DELIVERY_BOY_ASSIGNED
        order.status = "Out for Delivery";
        order.ndrStatus = "Out for Delivery";
        order.reattempt = false;
        break;

      case 9: // DELIVERED
        order.status = "Delivered";
        if (order.ndrHistory.length > 0) {
          order.ndrStatus = "Delivered";
          order.reattempt = true;
        } else {
          order.ndrStatus = "";
          order.reattempt = false;
        }
        break;

      case 10: // CANCELLED
        order.status = "Cancelled";
        order.ndrStatus = "Cancelled";
        // Handle Wallet Refund
        const balanceToBeAdded = !order.totalFreightCharges || order.totalFreightCharges === "N/A"
          ? 0 : parseFloat(order.totalFreightCharges);

        if (balanceToBeAdded > 0 && !order.walletRefunded) {
          const userDoc = await User.findById(order.userId);
          if (userDoc) {
            const currentWallet = await Wallet.findById(userDoc.Wallet);
            if (currentWallet) {
              const alreadyRefunded = currentWallet.transactions.some(
                t => t.awb_number === order.awb_number && t.category === "credit" && t.description === "Freight Charges Received"
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
              }
            }
          }
        }
        break;

      case 11: // RTO_INITIATED
        order.status = "RTO";
        order.ndrStatus = "RTO";
        order.reattempt = false;
        break;

      case 12: // RTO_DELIVERED
        order.status = "RTO Delivered";
        order.ndrStatus = "RTO Delivered";
        order.reattempt = false;
        break;

      case 13: // NDR
      case 2: // PICKUP_ERROR
      case 4: // PICKUP_EXCEPTION
        order.status = "Undelivered";
        order.ndrStatus = "Undelivered";
        order.reattempt = true;

        const attemptCount = order.ndrHistory.length + 1;
        order.ndrReason = { date: timestamp, reason: remark };

        // Push to NDR history if not duplicate
        const lastNdr = order.ndrHistory[order.ndrHistory.length - 1];
        const lastActionDate = lastNdr?.actions[lastNdr.actions.length - 1]?.date;

        if (!lastActionDate || new Date(timestamp).getTime() > new Date(lastActionDate).getTime()) {
          order.ndrHistory.push({
            actions: [
              {
                action: `NDR ${attemptCount} Raised`,
                actionBy: "ShipRocket",
                remark: remark,
                source: "ShipRocket",
                date: timestamp,
              },
            ],
          });
        }
        break;

      case 19: // RE-ATTEMPT_REQUESTED
        order.status = "In-transit";
        order.ndrStatus = "Action_Requested";
        break;

      default:
        // Keep current status if unknown
        break;
    }

    /* ================================================================
       SAVE TRACKING ENTRY
    ================================================================ */
    order.tracking.push({
      Instructions: remark,
      Status: statusText,
      StatusDateTime: timestamp,
      StatusLocation: location,
    });

    await order.save();

    // 🔹 Trigger Notifications if status changed
    if (order.status !== oldStatus) {
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
          console.error("ShipRocket Webhook Notification Error:", e.message);
        }
      })();
    }

    return res.status(200).json({ success: true, message: "Webhook processed successfully" });
  } catch (error) {
    console.error("ShipRocket Webhook Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

module.exports = { ShipRocketWebhook };
