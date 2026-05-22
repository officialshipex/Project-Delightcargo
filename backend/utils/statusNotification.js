const { sendWhatsAppMessage, sendEmailMessage, sendSMSMessage } = require("../notification/notification.controller");
const User = require("../models/User.model");
const Wallet = require("../models/wallet");

/**
 * Triggers notifications for an order based on its current status.
 * Checks user settings and wallet balance.
 * @param {Object} order - The order document from MongoDB
 */
const triggerStatusNotification = async (order) => {
  try {
    if (!order || !order.status) return;

    console.log(`🔔 Triggering notification for AWB: ${order.awb_number}, Status: ${order.status}`);

    const user = await User.findById(order.userId).select("Wallet");
    if (!user || !user.Wallet) return;

    const wallet = await Wallet.findById(user.Wallet).select("creditBalance");
    const credit = wallet?.creditBalance || 0;

    const notificationData = {
      userId: order.userId,
      awb_number: order.awb_number,
      status: order.status,
      date: new Date(),
      credit: credit,
      mobile_number: order.receiverAddress?.phoneNumber,
      email: order.receiverAddress?.email,
    };

    // Fire and forget (don't await to avoid blocking the caller)
    (async () => {
      try {
        console.log(`📡 Dispatching notifications for AWB: ${order.awb_number}...`);
        const results = await Promise.allSettled([
          sendWhatsAppMessage(notificationData),
          sendEmailMessage(notificationData),
          sendSMSMessage(notificationData)
        ]);
        
        results.forEach((res, index) => {
          const types = ["WhatsApp", "Email", "SMS"];
          if (res.status === "fulfilled" && res.value?.success) {
            console.log(`✅ ${types[index]} sent successfully for AWB: ${order.awb_number}`);
          } else if (res.status === "rejected" || (res.value && !res.value.success)) {
            console.log(`⚠️ ${types[index]} skipped or failed for AWB: ${order.awb_number}. Reason: ${res.value?.reason || 'Unknown'}`);
          }
        });
      } catch (e) {
        console.error("❌ Notification dispatch error:", e.message);
      }
    })();
  } catch (error) {
    console.error("triggerStatusNotification error:", error.message);
  }
};

module.exports = { triggerStatusNotification };
