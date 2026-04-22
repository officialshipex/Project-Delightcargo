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
    isAdminWhatsAppEnable: { type: Boolean, default: true },
    isUserSMSEnable: { type: Boolean, default: false },
    isAdminSMSEnable: { type: Boolean, default: true },
    isUserEmailEnable: { type: Boolean, default: false },
    isAdminEmailEnable: { type: Boolean, default: true },

    // 🔹 WhatsApp Toggles + Templates
    isWhatsAppBookedEnable: { type: Boolean, default: false },
    whatsappBookedUpdatedAt: { type: Date },
    whatsappBookedTemplate: { type: String, default: "" },
    whatsappBookedSubject: { type: String, default: "" },

    isWhatsAppPickupPendingEnable: { type: Boolean, default: false },
    whatsappPickupPendingUpdatedAt: { type: Date },
    whatsappPickupPendingTemplate: { type: String, default: "" },
    whatsappPickupPendingSubject: { type: String, default: "" },

    isWhatsAppPickupCompletedEnable: { type: Boolean, default: false },
    whatsappPickupCompletedUpdatedAt: { type: Date },
    whatsappPickupCompletedTemplate: { type: String, default: "" },
    whatsappPickupCompletedSubject: { type: String, default: "" },

    isWhatsAppIntransitEnable: { type: Boolean, default: false },
    whatsappIntransitUpdatedAt: { type: Date },
    whatsappIntransitTemplate: { type: String, default: "" },
    whatsappIntransitSubject: { type: String, default: "" },

    isWhatsAppAtDeliveryCenterEnable: { type: Boolean, default: false },
    whatsappAtDeliveryCenterUpdatedAt: { type: Date },
    whatsappAtDeliveryCenterTemplate: { type: String, default: "" },
    whatsappAtDeliveryCenterSubject: { type: String, default: "" },

    isWhatsAppOutForDeliveryEnable: { type: Boolean, default: false },
    whatsappOutForDeliveryUpdatedAt: { type: Date },
    whatsappOutForDeliveryTemplate: { type: String, default: "" },
    whatsappOutForDeliverySubject: { type: String, default: "" },

    isWhatsAppDeliveredEnable: { type: Boolean, default: false },
    whatsappDeliveredUpdatedAt: { type: Date },
    whatsappDeliveredTemplate: { type: String, default: "" },
    whatsappDeliveredSubject: { type: String, default: "" },

    isWhatsAppUndeliveredEnable: { type: Boolean, default: false },
    whatsappUndeliveredUpdatedAt: { type: Date },
    whatsappUndeliveredTemplate: { type: String, default: "" },
    whatsappUndeliveredSubject: { type: String, default: "" },

    isWhatsAppRTOEnable: { type: Boolean, default: false },
    whatsappRTOUpdatedAt: { type: Date },
    whatsappRTOTemplate: { type: String, default: "" },
    whatsappRTOSubject: { type: String, default: "" },

    isWhatsAppCancelledEnable: { type: Boolean, default: false },
    whatsappCancelledUpdatedAt: { type: Date },
    whatsappCancelledTemplate: { type: String, default: "" },
    whatsappCancelledSubject: { type: String, default: "" },

    // 🔹 SMS Toggles + Templates
    isSMSBookedEnable: { type: Boolean, default: false },
    smsBookedUpdatedAt: { type: Date },
    smsBookedTemplate: { type: String, default: "" },
    smsBookedSubject: { type: String, default: "" },

    isSMSPickupPendingEnable: { type: Boolean, default: false },
    smsPickupPendingUpdatedAt: { type: Date },
    smsPickupPendingTemplate: { type: String, default: "" },
    smsPickupPendingSubject: { type: String, default: "" },

    isSMSPickupCompletedEnable: { type: Boolean, default: false },
    smsPickupCompletedUpdatedAt: { type: Date },
    smsPickupCompletedTemplate: { type: String, default: "" },
    smsPickupCompletedSubject: { type: String, default: "" },

    isSMSIntransitEnable: { type: Boolean, default: false },
    smsIntransitUpdatedAt: { type: Date },
    smsIntransitTemplate: { type: String, default: "" },
    smsIntransitSubject: { type: String, default: "" },

    isSMSAtDeliveryCenterEnable: { type: Boolean, default: false },
    smsAtDeliveryCenterUpdatedAt: { type: Date },
    smsAtDeliveryCenterTemplate: { type: String, default: "" },
    smsAtDeliveryCenterSubject: { type: String, default: "" },

    isSMSOutForDeliveryEnable: { type: Boolean, default: false },
    smsOutForDeliveryUpdatedAt: { type: Date },
    smsOutForDeliveryTemplate: { type: String, default: "" },
    smsOutForDeliverySubject: { type: String, default: "" },

    isSMSDeliveredEnable: { type: Boolean, default: false },
    smsDeliveredUpdatedAt: { type: Date },
    smsDeliveredTemplate: { type: String, default: "" },
    smsDeliveredSubject: { type: String, default: "" },

    isSMSUndeliveredEnable: { type: Boolean, default: false },
    smsUndeliveredUpdatedAt: { type: Date },
    smsUndeliveredTemplate: { type: String, default: "" },
    smsUndeliveredSubject: { type: String, default: "" },

    isSMSRTOEnable: { type: Boolean, default: false },
    smsRTOUpdatedAt: { type: Date },
    smsRTOTemplate: { type: String, default: "" },
    smsRTOSubject: { type: String, default: "" },

    isSMSCancelledEnable: { type: Boolean, default: false },
    smsCancelledUpdatedAt: { type: Date },
    smsCancelledTemplate: { type: String, default: "" },
    smsCancelledSubject: { type: String, default: "" },

    // 🔹 Email Toggles + Templates
    isEmailBookedEnable: { type: Boolean, default: false },
    emailBookedUpdatedAt: { type: Date },
    emailBookedTemplate: { type: String, default: "" },
    emailBookedSubject: { type: String, default: "" },

    isEmailPickupPendingEnable: { type: Boolean, default: false },
    emailPickupPendingUpdatedAt: { type: Date },
    emailPickupPendingTemplate: { type: String, default: "" },
    emailPickupPendingSubject: { type: String, default: "" },

    isEmailPickupCompletedEnable: { type: Boolean, default: false },
    emailPickupCompletedUpdatedAt: { type: Date },
    emailPickupCompletedTemplate: { type: String, default: "" },
    emailPickupCompletedSubject: { type: String, default: "" },

    isEmailIntransitEnable: { type: Boolean, default: false },
    emailIntransitUpdatedAt: { type: Date },
    emailIntransitTemplate: { type: String, default: "" },
    emailIntransitSubject: { type: String, default: "" },

    isEmailAtDeliveryCenterEnable: { type: Boolean, default: false },
    emailAtDeliveryCenterUpdatedAt: { type: Date },
    emailAtDeliveryCenterTemplate: { type: String, default: "" },
    emailAtDeliveryCenterSubject: { type: String, default: "" },

    isEmailOutForDeliveryEnable: { type: Boolean, default: false },
    emailOutForDeliveryUpdatedAt: { type: Date },
    emailOutForDeliveryTemplate: { type: String, default: "" },
    emailOutForDeliverySubject: { type: String, default: "" },

    isEmailDeliveredEnable: { type: Boolean, default: false },
    emailDeliveredUpdatedAt: { type: Date },
    emailDeliveredTemplate: { type: String, default: "" },
    emailDeliveredSubject: { type: String, default: "" },

    isEmailUndeliveredEnable: { type: Boolean, default: false },
    emailUndeliveredUpdatedAt: { type: Date },
    emailUndeliveredTemplate: { type: String, default: "" },
    emailUndeliveredSubject: { type: String, default: "" },

    isEmailRTOEnable: { type: Boolean, default: false },
    emailRTOUpdatedAt: { type: Date },
    emailRTOTemplate: { type: String, default: "" },
    emailRTOSubject: { type: String, default: "" },

    isEmailCancelledEnable: { type: Boolean, default: false },
    emailCancelledUpdatedAt: { type: Date },
    emailCancelledTemplate: { type: String, default: "" },
    emailCancelledSubject: { type: String, default: "" },

    // 🔹 AI Calling Settings
    isAiOrderVerifyEnable: { type: Boolean, default: false },
    isAdminAiOrderVerifyEnable: { type: Boolean, default: true },
    isAiNdrFollowupEnable: { type: Boolean, default: false },
    isAdminAiNdrFollowupEnable: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("NotificationSetting", notificationSettingSchema);
