const mongoose = require("mongoose");

const notificationSettingSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    // 🔹 Master Toggles
    isUserWhatsAppEnable: { type: Boolean, default: false },
    isAdminWhatsAppEnable: { type: Boolean, default: false },
    isUserSMSEnable: { type: Boolean, default: false },
    isAdminSMSEnable: { type: Boolean, default: false },
    isUserEmailEnable: { type: Boolean, default: false },
    isAdminEmailEnable: { type: Boolean, default: false },

    // 🔹 WhatsApp Toggles + Updated Dates
    isWhatsAppPickupPendingEnable: { type: Boolean, default: false },
    whatsappPickupPendingUpdatedAt: { type: Date },
    isWhatsAppIntransitEnable: { type: Boolean, default: false },
    whatsappIntransitUpdatedAt: { type: Date },
    isWhatsAppOutForDeliveryEnable: { type: Boolean, default: false },
    whatsappOutForDeliveryUpdatedAt: { type: Date },
    isWhatsAppDeliveredEnable: { type: Boolean, default: false },
    whatsappDeliveredUpdatedAt: { type: Date },
    isWhatsAppUndeliveredEnable: { type: Boolean, default: false },
    whatsappUndeliveredUpdatedAt: { type: Date },
    isWhatsAppRTOEnable: { type: Boolean, default: false },
    whatsappRTOUpdatedAt: { type: Date },

    // 🔹 SMS Toggles + Updated Dates
    isSMSPickupPendingEnable: { type: Boolean, default: false },
    smsPickupPendingUpdatedAt: { type: Date },
    isSMSIntransitEnable: { type: Boolean, default: false },
    smsIntransitUpdatedAt: { type: Date },
    isSMSOutForDeliveryEnable: { type: Boolean, default: false },
    smsOutForDeliveryUpdatedAt: { type: Date },
    isSMSDeliveredEnable: { type: Boolean, default: false },
    smsDeliveredUpdatedAt: { type: Date },
    isSMSUndeliveredEnable: { type: Boolean, default: false },
    smsUndeliveredUpdatedAt: { type: Date },
    isSMSRTOEnable: { type: Boolean, default: false },
    smsRTOUpdatedAt: { type: Date },

    // 🔹 Email Toggles + Updated Dates
    isEmailPickupPendingEnable: { type: Boolean, default: false },
    emailPickupPendingUpdatedAt: { type: Date },
    isEmailIntransitEnable: { type: Boolean, default: false },
    emailIntransitUpdatedAt: { type: Date },
    isEmailOutForDeliveryEnable: { type: Boolean, default: false },
    emailOutForDeliveryUpdatedAt: { type: Date },
    isEmailDeliveredEnable: { type: Boolean, default: false },
    emailDeliveredUpdatedAt: { type: Date },
    isEmailUndeliveredEnable: { type: Boolean, default: false },
    emailUndeliveredUpdatedAt: { type: Date },
    isEmailRTOEnable: { type: Boolean, default: false },
    emailRTOUpdatedAt: { type: Date },
  },
  { timestamps: true }
);

module.exports= mongoose.model("NotificationSetting", notificationSettingSchema);
