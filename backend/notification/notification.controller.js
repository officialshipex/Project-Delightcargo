const NotificationSetting = require("./notification.model");
const User = require("../models/User.model");
const Wallet = require("../models/wallet");
const mongoose = require("mongoose");
const MessageLog = require("./messageCheck.model");
const axios = require("axios");
const Order = require("../models/newOrder.model");
const transporter = require("./configEmailpass");
// 🔹 Get user WhatsApp settings
const getNotificationSettings = async (req, res) => {
  try {
    const userId = req.user?._id; // Assuming authentication middleware
    const settings = await NotificationSetting.findOne({ userId });

    if (!settings) {
      const newSetting = await NotificationSetting.create({ userId });
      return res.json(newSetting);
    }

    res.json(settings);
  } catch (error) {
    console.error("Error fetching WhatsApp settings:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// 🔹 Update any field dynamically
const updateNotificationSetting = async (req, res) => {
  try {
    const userId = req.user?._id;
    const { field, value } = req.body;

    if (!field)
      return res.status(400).json({ error: "Field name is required" });

    const updateData = { [field]: value };
    let timestampField = null;
    if (field.startsWith("isWhatsApp")) {
      const statusKey = field.replace("isWhatsApp", "").replace("Enable", "");
      timestampField = `whatsapp${statusKey}UpdatedAt`;
    }

    // SMS status toggle timestamp
    else if (field.startsWith("isSMS")) {
      const statusKey = field.replace("isSMS", "").replace("Enable", "");
      timestampField = `sms${statusKey}UpdatedAt`;
    }

    // Email status toggle timestamp
    else if (field.startsWith("isEmail")) {
      const statusKey = field.replace("isEmail", "").replace("Enable", "");
      timestampField = `email${statusKey}UpdatedAt`;
    }

    // If a timestamp field is determined, update it
    if (timestampField) {
      updateData[timestampField] = new Date();
    }

    const updated = await NotificationSetting.findOneAndUpdate(
      { userId },
      { $set: updateData },
      { new: true, upsert: true }
    );

    res.json({ success: true, updated, updatedAt: new Date() });
  } catch (error) {
    console.error("Error updating WhatsApp setting:", error);
    res.status(500).json({ error: "Server error" });
  }
};

const generateUniqueCreditOrderId = async () => {
  let unique = false;
  let orderId;

  while (!unique) {
    const randomNum = Math.floor(100000 + Math.random() * 900000);
    orderId = `CR${randomNum}`;

    const existing = await Wallet.findOne({
      "transactions.channelOrderId": orderId,
    });

    if (!existing) unique = true;
  }

  return orderId;
};

const buyCredits = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const userId = req.user._id;
    const { amount } = req.body;

    if (!amount || amount <= 0) {
      await session.abortTransaction();
      return res.status(400).json({ error: "Invalid amount." });
    }

    const user = await User.findById(userId).populate("Wallet");
    if (!user || !user.Wallet) {
      await session.abortTransaction();
      return res.status(404).json({ error: "Wallet not found." });
    }

    const wallet = await Wallet.findById(user.Wallet._id).session(session);
    if (!wallet) {
      await session.abortTransaction();
      return res.status(404).json({ error: "Wallet not found." });
    }

    // ✅ Ensure balances are numbers
    wallet.balance = Number(wallet.balance) || 0;
    wallet.creditBalance = Number(wallet.creditBalance) || 0;

    // 🧮 Check if main balance has enough funds
    if (wallet.balance < amount) {
      await session.abortTransaction();
      return res.status(400).json({
        error: "Insufficient balance. Please add funds to your wallet.",
      });
    }

    // 🆔 Generate unique orderId
    const orderId = await generateUniqueCreditOrderId();

    // 💰 Update balances safely
    wallet.balance -= Number(amount);
    wallet.creditBalance += Number(amount);

    // 🧾 Add transaction record
    wallet.transactions.push({
      channelOrderId: orderId,
      category: "debit",
      amount: Number(amount),
      balanceAfterTransaction: wallet.balance,
      description: `Converted ₹${amount} to Credits`,
      createdAt: new Date(),
    });

    // 💾 Save with transaction
    await wallet.save({ session });
    await session.commitTransaction();

    return res.status(200).json({
      message: "Credits purchased successfully.",
      orderId,
      mainBalance: wallet.balance,
      creditBalance: wallet.creditBalance,
    });
  } catch (error) {
    await session.abortTransaction();
    console.error("Error in buyCredits:", error);
    return res.status(500).json({ error: "Internal server error." });
  } finally {
    session.endSession();
  }
};

const getCreditBalance = async (req, res) => {
  try {
    const userId = req.user._id;

    const user = await User.findById(userId).populate("Wallet");
    if (!user || !user.Wallet) {
      return res.status(404).json({ error: "Wallet not found." });
    }

    const wallet = await Wallet.findById(user.Wallet._id).select(
      "creditBalance"
    );

    if (!wallet) {
      return res.status(404).json({ error: "Wallet not found." });
    }

    return res.status(200).json({
      message: "Credit balance fetched successfully.",
      creditBalance: wallet.creditBalance || 0,
    });
  } catch (error) {
    console.error("Error in getCreditBalance:", error);
    return res.status(500).json({ error: "Internal server error." });
  }
};

const messageSent = async () => {
  try {
    const allSettings = await NotificationSetting.find({}).lean();
    if (!allSettings.length) {
      console.log("No notification settings found.");
      return;
    }

    const validStatuses = [
      "Ready To Ship",
      "In-transit",
      "Out for Delivery",
      "Delivered",
      "Undelivered",
      "RTO",
    ];

    const today = new Date().toISOString().split("T")[0];

    for (const setting of allSettings) {
      const { userId } = setting;
     
      if (!userId) continue;

      // 🟡 Fetch orders for this user (filtered by test AWB)
      const userOrders = await Order.find({
        userId,
        // awb_number: testAwb,
        status: { $in: validStatuses },
      }).lean();
     

      if (!userOrders.length) continue;

      // 🟢 Filter today's tracking updates
      const todayOrders = userOrders.filter((order) => {
        const lastTracking = order.tracking?.[order.tracking.length - 1];
        if (!lastTracking?.StatusDateTime) return false;
        const trackDate = new Date(lastTracking.StatusDateTime)
          .toISOString()
          .split("T")[0];
        return trackDate === today;
      });

      if (!todayOrders.length) continue;

      // 🟠 Skip credit check if admin channels are enabled
      const skipCreditCheck =
        setting.isAdminWhatsAppEnable ||
        setting.isAdminSMSEnable ||
        setting.isAdminEmailEnable;

      let wallet = null;
      if (!skipCreditCheck) {
        const user = await User.findById(userId).populate("Wallet");
        if (!user?.Wallet) continue;

        wallet = await Wallet.findById(user.Wallet._id);
        if (!wallet || wallet.creditBalance <= 0) {
          console.log(`User ${userId} has insufficient credits.`);
          continue;
        }
      }

      const hasAnyChannelEnabled =
        setting.isUserWhatsAppEnable ||
        setting.isUserSMSEnable ||
        setting.isUserEmailEnable;

      if (!hasAnyChannelEnabled) continue;

      // 🧠 Filter out duplicate (already sent) messages
      const filteredOrders = [];
      for (const order of todayOrders) {
        console.log("order",order)
        const existingLog = await MessageLog.findOne({
          userId,
          awb_number: order.awb_number,
          status: order.status,
        });

        if (existingLog) {
          console.log(
            `Skipped duplicate: ${order.awb_number} (${order.status})`
          );
          continue;
        }
        filteredOrders.push(order);
      }
      if (!filteredOrders.length) continue;

      // ✅ Process all eligible orders
      for (const order of filteredOrders) {
        const messagePayload = {
          userId: userId,
          credit: wallet?.creditBalance || 0,
          awb_number: order.awb_number,
          status: order.status,
          date: new Date(),
          mobile_number: order.receiverAddress.phoneNumber,
          email: order.receiverAddress.email,
          isAdminWhatsAppEnable: setting.isAdminWhatsAppEnable,
          isAdminSmsEnable: setting.isAdminSMSEnable,
          isAdminEmailEnable: setting.isAdminEmailEnable,
        };

        let isWhatsAppSent = false;
        let isSMSSent = false;
        let isEmailSent = false;
        let totalCharge = 0;

        try {
          // 🟢 Send WhatsApp Message
          if (setting.isUserWhatsAppEnable || setting.isAdminWhatsAppEnable) {
            const data = await sendWhatsAppMessage(messagePayload);
            if (data.success) {
              isWhatsAppSent = true;
              if (!skipCreditCheck) totalCharge += 1; // ₹1 for WhatsApp
            }
          }

          // 🟣 Send SMS Message
          if (setting.isUserSMSEnable || setting.isAdminSMSEnable) {
            const data = await sendSMSMessage(messagePayload);
            if (data.success) {
              isSMSSent = true;
              if (!skipCreditCheck) totalCharge += 1; // ₹1 for SMS
            }
          }

          // 🟠 Send Email Message
          if (setting.isUserEmailEnable || setting.isAdminEmailEnable) {
            const data = await sendEmailMessage(messagePayload);
            console.log("data", data);
            if (data.success) {
              isEmailSent = true;
            }
          }

          // 💰 Deduct total credits (₹1 per message type)
          if (!skipCreditCheck && totalCharge > 0) {
            wallet.creditBalance -= totalCharge;
            await wallet.save();
            console.log(
              `💸 Deducted ₹${totalCharge} for user ${userId} — New balance: ₹${wallet.creditBalance}`
            );

            // 🟢 Log successful message
            await MessageLog.create({
              userId,
              awb_number: order.awb_number,
              status: order.status,
              isEmailSent,
              isWhatsAppSent,
              isSMSSent,
            });
          }

          console.log(
            `✅ Message sent for ${order.awb_number} (${order.status}) — WhatsApp: ${isWhatsAppSent}, SMS: ${isSMSSent}`
          );
        } catch (err) {
          console.error(
            `❌ Error sending message for ${order.awb_number}:`,
            err.message
          );
        }
      }
    }
  } catch (error) {
    console.error("❌ Error in messageSent:", error);
  }
};

const startMessageLoop = async () => {
  try {
    // Get current time in IST
    const istDate = new Date(
      new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" })
    );
    const currentHour = istDate.getHours();

    if (currentHour < 7) {
      const next7am = new Date(istDate);
      next7am.setHours(7, 0, 0, 0);
      const delay = next7am.getTime() - istDate.getTime();
      console.log(
        `🕖 Waiting until 7 AM to start (in ${(delay / 1000 / 60).toFixed(
          1
        )} min)...`
      );
      setTimeout(startMessageLoop, delay);
      return;
    }

    if (currentHour >= 7 && currentHour <= 22) {
      console.log(
        "🕒 Starting message sent at",
        istDate.toLocaleTimeString("en-IN")
      );
      await messageSent();
      console.log("✅ message sent completed. Next run after 5 hour...");
      setTimeout(startMessageLoop, 5 * 60 * 60 * 1000); // 5 hour
    } else {
      console.log(
        "🌙 Outside message sent window, will retry in 1 hour:",
        istDate.toLocaleTimeString("en-IN")
      );
      setTimeout(startMessageLoop, 60 * 60 * 1000);
    }
  } catch (error) {
    console.error("❌ Error in message sent loop:", error);
    // setTimeout(startTrackingLoop, 15 * 60 * 1000); // retry after 15 min
  }
};

if (process.env.NODE_ENV === "production") {
  startMessageLoop();
}


// messageSent("365045787027");

const BASE_URL = process.env.WHATSAPP_BASE_URL;
const API_KEY = process.env.WHATSAPP_API_KEY;
const PHONE_NUMBER_ID = process.env.WHATSAPP_NUMBER_ID;

const statuses = [
  {
    key: "Ready To Ship",
    label: "Pickup Pending",
    template:
      "Dear Customer, your order has been created and is pending pickup. We'll notify you once it’s picked up. Track: {tracking_link}",
  },
  {
    key: "In-transit",
    label: "In Transit",
    template:
      "Good news! Your order is on the way and currently in transit. Track your package here: {tracking_link}",
  },
  {
    key: "Out for Delivery",
    label: "Out for Delivery",
    template:
      "Your order is out for delivery. Please keep your phone available. Track: {tracking_link}",
  },
  {
    key: "Delivered",
    label: "Delivered",
    template:
      "Your order has been successfully delivered. Thank you for choosing us!",
  },
  {
    key: "Undelivered",
    label: "Undelivered",
    template:
      "Delivery attempt was unsuccessful. We will retry soon. Track your shipment: {tracking_link}",
  },
  {
    key: "RTO",
    label: "RTO Initiated",
    template:
      "Your order is being returned to the sender (RTO initiated). You can track it here: {tracking_link}",
  },
];

const sendWhatsAppMessage = async ({
  userId,
  credit,
  awb_number,
  status,
  date,
  isAdminWhatsAppEnable,
  mobile_number,
}) => {
  try {
    if (!mobile_number) throw new Error("Recipient mobile number is required.");
    if (!status) throw new Error("Shipment status is required.");

    // ✅ Fetch Notification Settings for this user
    const setting = await NotificationSetting.findOne({ userId }).lean();
    if (!setting) {
      console.log(`⚠️ No notification settings found for user: ${userId}`);
      return { success: false };
    }

    // ✅ Map status → field name in NotificationSettings
    const statusFieldMap = {
      "Ready To Ship": "isWhatsAppPickupPendingEnable",
      "In-transit": "isWhatsAppIntransitEnable",
      "Out for Delivery": "isWhatsAppOutForDeliveryEnable",
      Delivered: "isWhatsAppDeliveredEnable",
      Undelivered: "isWhatsAppUndeliveredEnable",
      RTO: "isWhatsAppRTOEnable",
    };

    const fieldName = statusFieldMap[status];
    if (!fieldName) {
      console.log(`⚠️ No mapped field found for status: ${status}`);
      return { success: false };
    }

    // ✅ Check if WhatsApp toggle is enabled for this status
    if (!setting[fieldName]) {
      console.log(
        `🚫 WhatsApp notification disabled for ${status} (user: ${userId})`
      );
      return { success: false };
    }

    // ✅ Check credit if admin WhatsApp is not enabled
    if (!isAdminWhatsAppEnable && (!credit || credit <= 0)) {
      console.log(`❌ Insufficient credits for user: ${userId}`);
      return { success: false };
    }

    // ✅ Find matching template for status
    const matchedStatus = statuses.find((s) => s.key === status);
    if (!matchedStatus) {
      console.log(`⚠️ No WhatsApp template found for status: ${status}`);
      return { success: false };
    }

    // ✅ Replace placeholders in template
    const tracking_link = `https://www.shipexindia.com/track/${awb_number}`;
    const messageBody = matchedStatus.template.replace(
      "{tracking_link}",
      tracking_link
    );

    // ✅ Create payload
    const payload = {
      phoneNoId: PHONE_NUMBER_ID,
      to: mobile_number,
      type: "text",
      text: messageBody,
    };

    // ✅ Send via API
    const response = await axios.post(
      `${BASE_URL}/v2/whatsapp-business/messages`,
      payload,
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
        },
      }
    );

    console.log("✅ WhatsApp message sent:", {
      to: mobile_number,
      awb_number,
      status,
      date,
    });

    return { success: true, data: response.data };
  } catch (error) {
    console.error(
      "❌ Error sending WhatsApp message:",
      error.response?.data || error.message
    );
    return { success: false };
  }
};

const sendEmailMessage = async ({
  userId,
  credit,
  awb_number,
  status,
  date,
  isAdminEmailEnable,
  email,
}) => {
  try {
    if (!email) throw new Error("Recipient email address is required.");
    if (!status) throw new Error("Shipment status is required.");

    // ✅ Fetch user's notification settings
    const setting = await NotificationSetting.findOne({ userId }).lean();
    if (!setting) {
      console.log(`⚠️ No email settings found for user: ${userId}`);
      return { success: false };
    }

    // ✅ Map status → field name in NotificationSettings
    const statusFieldMap = {
      "Ready To Ship": "isEmailPickupPendingEnable",
      "In-transit": "isEmailIntransitEnable",
      "Out for Delivery": "isEmailOutForDeliveryEnable",
      Delivered: "isEmailDeliveredEnable",
      Undelivered: "isEmailUndeliveredEnable",
      RTO: "isEmailRTOEnable",
    };

    const fieldName = statusFieldMap[status];
    if (!fieldName) {
      console.log(`⚠️ No mapped email field for status: ${status}`);
      return { success: false };
    }

    // ✅ Check if email toggle is enabled
    if (!setting[fieldName]) {
      console.log(
        `🚫 Email notification disabled for ${status} (user: ${userId})`
      );
      return { success: false };
    }

    // ✅ Check credit balance if admin email is not enabled
    if (!isAdminEmailEnable && (!credit || credit <= 0)) {
      console.log(`❌ Insufficient credits for user: ${userId}`);
      return { success: false };
    }

    // ✅ Find matching template
    const matchedStatus = statuses.find((s) => s.key === status);
    if (!matchedStatus) {
      console.log(`⚠️ No email template found for status: ${status}`);
      return { success: false };
    }

    // ✅ Prepare message
    const tracking_link = `https://www.shipexindia.com/track/${awb_number}`;
    const messageBody = matchedStatus.template.replace(
      "{tracking_link}",
      tracking_link
    );

    // ✅ Email HTML Template
    const htmlTemplate = `
      <table cellspacing="0" cellpadding="0" style="margin:0 auto; width:100%; background-color:#f9f9f9;">
        <tr>
          <td>
            <div style="background:#fff; border:1px solid #eee; font-family:Lato, Helvetica, Arial, sans-serif; margin:32px auto; max-width:500px; border-radius:16px; overflow:hidden; box-sizing:border-box;">
              <div style="padding: 25px 0; background:#eee; text-align:center;">
                <img src="https://shipex-india.s3.ap-south-1.amazonaws.com/uploads/1758806046534_shipexNoBG.png" alt="Shipex Logo" style="max-height:60px; width:auto;" />
              </div>
              <div style="padding:24px; text-align:center;">
                <h1 style="color:#222; font-size:22px; font-weight:700;">${matchedStatus.label}</h1>
                <p style="font-size:15px; color:#222; margin-bottom:24px;">${messageBody}</p>
                <a href="${tracking_link}" style="display:inline-block; background:#1658db; color:#fff; padding:10px 20px; border-radius:8px; text-decoration:none; font-weight:600;">Track Shipment</a>
                <hr style="border:0; border-bottom:1px solid #eee; margin:28px 0 16px;">
                <p style="font-size:14px; color:#232323;">
                  Need help? Contact us at 
                  <a href="mailto:info@shipexindia.com" style="color:#0CBB7D;">info@shipexindia.com</a>
                </p>
                <div style="margin-top:18px; font-size:14px; color:#444;">
                  Best Regards,<br><strong>Team Shipex India</strong>
                </div>
              </div>
            </div>
          </td>
        </tr>
      </table>
    `;

    const mailOptions = {
      from: '"Shipex Team" <info@shipexindia.com>',
      to: email,
      subject: `Shipex | ${matchedStatus.label}`,
      html: htmlTemplate,
    };

    // ✅ Send email
    const sentMail = await transporter.sendMail(mailOptions);

    console.log("✅ Email sent:", {
      to: email,
      awb_number,
      status,
      date,
    });

    return { success: true, data: sentMail };
  } catch (error) {
    console.error("❌ Error sending email:", error.message || error);
    return { success: false, error: error.message };
  }
};

const sendSMSMessage = async ({
  userId,
  credit,
  awb_number,
  status,
  date,
  isAdminSmsEnable,
  mobile_number,
}) => {
  try {
    if (!mobile_number) throw new Error("Recipient phone number is required.");
    if (!status) throw new Error("Shipment status is required.");

    // ✅ Fetch user's notification settings
    const setting = await NotificationSetting.findOne({ userId }).lean();
    if (!setting) {
      console.log(`⚠️ No SMS settings found for user: ${userId}`);
      return { success: false };
    }

    // ✅ Map status → field name in NotificationSettings
    const statusFieldMap = {
      "Ready To Ship": "isSmsPickupPendingEnable",
      "In-transit": "isSmsIntransitEnable",
      "Out for Delivery": "isSmsOutForDeliveryEnable",
      Delivered: "isSmsDeliveredEnable",
      Undelivered: "isSmsUndeliveredEnable",
      RTO: "isSmsRTOEnable",
    };

    const fieldName = statusFieldMap[status];
    if (!fieldName) {
      console.log(`⚠️ No mapped SMS field found for status: ${status}`);
      return { success: false };
    }

    // ✅ Check if SMS toggle is enabled
    if (!setting[fieldName]) {
      console.log(
        `🚫 SMS notification disabled for ${status} (user: ${userId})`
      );
      return { success: false };
    }

    // ✅ Check credit balance if admin SMS is not enabled
    if (!isAdminSmsEnable && (!credit || credit <= 0)) {
      console.log(`❌ Insufficient credits for user: ${userId}`);
      return { success: false };
    }

    // ✅ Find matching template
    const matchedStatus = statuses.find((s) => s.key === status);
    if (!matchedStatus) {
      console.log(`⚠️ No SMS template found for status: ${status}`);
      return { success: false };
    }

    // ✅ Prepare message
    const tracking_link = `https://www.shipexindia.com/track/${awb_number}`;
    const messageBody = matchedStatus.template.replace(
      "{tracking_link}",
      tracking_link
    );

    console.log(`📨 Sending SMS to ${mobile_number}: ${messageBody}`);

    // ✅ Send SMS using YourBulkSMS API
    const response = await axios.get(
      "http://control.yourbulksms.com/api/sendhttp.php?",
      {
        params: {
          authkey: process.env.SMS_API_KEY, // Store in .env file
          mobiles: mobile_number,
          message: `${messageBody} - Team Shipex`,
          sender: process.env.SMS_SENDER_ID || "SHIPX",
          route: "2",
          country: "0",
          DLT_TE_ID: process.env.SMS_DLT_TEMPLATE_ID || "1707168499016611106",
        },
      }
    );

    console.log("📬 SMS API Response:", response.data);

    if (response.data.Status === "Success") {
      console.log("✅ SMS sent successfully:", {
        to: mobile_number,
        awb_number,
        status,
        date,
      });
      return { success: true, data: response.data };
    } else {
      console.error("❌ Failed SMS API Response:", response.data);
      return { success: false, data: response.data };
    }
  } catch (error) {
    console.error(
      "❌ Error sending SMS:",
      error.response?.data || error.message
    );
    return { success: false, error: error.message };
  }
};

module.exports = {
  getNotificationSettings,
  updateNotificationSetting,
  buyCredits,
  getCreditBalance,
};
