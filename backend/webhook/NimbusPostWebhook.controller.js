const Order = require("../models/newOrder.model");
const Wallet = require("../models/wallet");
const User = require("../models/User.model");
const WalletTransaction = require("../models/WalletTransaction.model");
const crypto = require("crypto");
const mongoose = require("mongoose");

const NimbusPostWebhook = async (req, res) => {
  try {
    const signatureHeader = req.headers["x-hmac-sha256"] || req.headers["X-Hmac-SHA256"];
    const secret = process.env.NIMBUSPOST_WEBHOOK_SECRET;

    // Webhook Signature verification (if secret configured)
    if (secret && signatureHeader) {
      const rawBody = req.rawBody || JSON.stringify(req.body);
      const computedSignature = crypto
        .createHmac("sha256", secret)
        .update(rawBody)
        .digest("base64");
      
      if (computedSignature !== signatureHeader) {
        console.warn("NimbusPost Webhook: Signature verification failed");
        return res.status(400).json({ success: false, message: "Invalid Signature" });
      }
    }

    const body = req.body;
    console.log("NimbusPost Webhook Received:", JSON.stringify(body, null, 2));

    const awb = body.awb_number;
    if (!awb) {
      console.warn("NimbusPost Webhook: Missing awb_number, skipping event.");
      return res.status(200).json({ success: false, message: "Missing awb_number" });
    }

    const eventStatus = (body.status || "").toLowerCase().trim();
    const location = body.location || "Unknown";
    const remark = body.message || body.remarks || "";
    
    // Parse event_time or fallback to current date
    let timestamp = new Date();
    if (body.event_time) {
      // NimbusPost event_time is formatted as "YYYY-MM-DD HH:mm:ss"
      // Since it's in IST (Indian standard time), parse it using Date.UTC component parser for IST timezone alignment
      const parts = String(body.event_time).trim().split(/[T\-:\s]/);
      if (parts.length >= 6) {
        const year = parseInt(parts[0], 10);
        const month = parseInt(parts[1], 10) - 1;
        const day = parseInt(parts[2], 10);
        const hour = parseInt(parts[3], 10);
        const minute = parseInt(parts[4], 10);
        const second = parseInt(parts[5], 10);
        timestamp = new Date(Date.UTC(year, month, day, hour, minute, second));
      } else {
        timestamp = new Date(body.event_time);
      }
    }

    // Fetch order by AWB
    const order = await Order.findOne({ awb_number: String(awb) });
    if (!order) {
      console.warn(`NimbusPost Webhook: Order not found for AWB ${awb}`);
      return res.status(200).json({ success: false, message: "Order not found" });
    }

    // Standard status checks
    if (["new", "Cancelled"].includes(order.status) && eventStatus !== "cancelled" && eventStatus !== "canceled") {
      console.log(`NimbusPost Webhook: Skipping AWB ${awb} because order status is "${order.status}"`);
      return res.status(200).json({ success: true, message: "Order inactive" });
    }

    // ── Duplicate Tracking Check ──
    const lastTracking = order.tracking[order.tracking.length - 1];
    if (
      lastTracking &&
      lastTracking.Instructions === remark &&
      lastTracking.StatusLocation === location &&
      new Date(lastTracking.StatusDateTime).getTime() === new Date(timestamp).getTime()
    ) {
      console.log(`NimbusPost Webhook: Duplicate tracking for AWB ${awb}, skipping.`);
      return res.status(200).json({ success: true, message: "Duplicate" });
    }

    // Status Mapping and NDR Handling
    let normalizedStatus = "";
    if (eventStatus === "delivered" || eventStatus === "dl") {
      normalizedStatus = "Delivered";
      order.status = "Delivered";
      order.ndrStatus = "Delivered";
      order.reattempt = false;
    } else if (eventStatus === "out for delivery" || eventStatus === "ofd") {
      normalizedStatus = "Out for Delivery";
      order.status = "Out for Delivery";
      order.ndrStatus = "Out for Delivery";
      order.reattempt = false;
    } else if (eventStatus === "in transit" || eventStatus === "it") {
      normalizedStatus = "In-transit";
      order.status = "In-transit";
      order.ndrStatus = "In-transit";
      order.reattempt = false;
    } else if (eventStatus === "rto" || eventStatus === "rt") {
      normalizedStatus = "RTO";
      order.status = "RTO";
      order.ndrStatus = "RTO";
      order.reattempt = false;
    } else if (eventStatus === "rto in transit" || eventStatus === "rt-it") {
      normalizedStatus = "RTO In-transit";
      order.status = "RTO In-transit";
      order.ndrStatus = "RTO In-transit";
      order.reattempt = false;
    } else if (eventStatus === "rto delivered" || eventStatus === "rt-dl") {
      normalizedStatus = "RTO Delivered";
      order.status = "RTO Delivered";
      order.ndrStatus = "RTO Delivered";
      order.reattempt = false;
    } else if (eventStatus === "cancelled" || eventStatus === "canceled") {
      normalizedStatus = "Cancelled";
      order.status = "Cancelled";
      order.ndrStatus = "Cancelled";
      order.reattempt = false;

      // Handle Wallet Refund
      const balanceToBeAdded = !order.totalFreightCharges || order.totalFreightCharges === "N/A"
        ? 0 : parseFloat(order.totalFreightCharges);

      if (balanceToBeAdded > 0 && !order.walletRefunded) {
        const userDoc = await User.findById(order.userId);
        if (userDoc) {
          const currentWallet = await Wallet.findById(userDoc.Wallet).select("balance");
          if (currentWallet) {
            // Try to atomically mark the order as walletRefunded: true
            const orderUpdated = await Order.findOneAndUpdate(
              {
                _id: order._id,
                walletRefunded: { $ne: true }
              },
              {
                $set: { walletRefunded: true, status: "Cancelled", ndrStatus: "Cancelled" }
              },
              { new: true }
            );

            if (orderUpdated) {
              const session = await mongoose.startSession();
              session.startTransaction();

              try {
                const alreadyRefunded = await WalletTransaction.exists({
                  walletId: currentWallet._id,
                  awb_number: order.awb_number,
                  category: "credit",
                  description: { $in: ["Freight Charges Received", "Freight Charges Refunded"] }
                }).session(session);

                if (!alreadyRefunded) {
                  const newBalance = (currentWallet.balance || 0) + balanceToBeAdded;
                  await Wallet.findOneAndUpdate(
                    { _id: currentWallet._id },
                    {
                      $inc: { balance: balanceToBeAdded },
                    },
                    { session }
                  );

                  await WalletTransaction.create(
                    [
                      {
                        walletId: currentWallet._id,
                        channelOrderId: order.orderId || null,
                        category: "credit",
                        amount: balanceToBeAdded,
                        balanceAfterTransaction: newBalance,
                        date: new Date(),
                        awb_number: order.awb_number,
                        description: "Freight Charges Received",
                      }
                    ],
                    { session }
                  );
                }

                await session.commitTransaction();
                session.endSession();
              } catch (err) {
                await session.abortTransaction();
                session.endSession();
                console.error("⚠️ Transaction failed in NimbusPostWebhook cancellation:", err.message);
              }

              order.walletRefunded = true;
            }
          }
        }
      }
    } else if (eventStatus === "pending pickup" || eventStatus === "pp" || eventStatus === "booked") {
      normalizedStatus = "Booked";
      order.status = "Booked";
    }

    // Save tracking entry
    order.tracking.push({
      Instructions: remark || normalizedStatus || "Update received",
      Status: normalizedStatus || body.status || "N/A",
      StatusDateTime: timestamp,
      StatusLocation: location,
    });

    await order.save();

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

    return res.status(200).json({ success: true, message: "Webhook processed successfully" });
  } catch (error) {
    console.error("NimbusPost Webhook Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

module.exports = { NimbusPostWebhook };
