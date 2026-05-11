const mongoose = require("mongoose");

const aiCallLogSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "newOrder",
      required: true,
    },
    awb_number: { type: String },
    orderDisplayId: { type: Number }, // human-readable order ID
    serviceType: {
      type: String,
      enum: ["order_verification", "ndr_followup"],
      required: true,
    },
    // EchQ API call_id / message_id for tracking
    callId: { type: String, index: true },
    // The phone number called
    calledNumber: { type: String },
    // Call outcome from EchQ callback
    callStatus: {
      type: String,
      enum: ["pending", "answered", "unanswered", "failed"],
      default: "pending",
    },
    // Full callback payload from EchQ for auditing
    callbackData: { type: mongoose.Schema.Types.Mixed, default: {} },
    // Customer's response captured by AI
    customerResponse: { type: String },
    // Recording URL if provided
    recordingUrl: { type: String },
    // Was a credit deducted?
    creditDeducted: { type: Boolean, default: false },
    // Order status was updated as result of this call?
    orderUpdated: { type: Boolean, default: false },
    // Error description if call failed to initiate
    errorMessage: { type: String },
  },
  { timestamps: true }
);

// Index for fast lookups
aiCallLogSchema.index({ userId: 1, createdAt: -1 });

const AiCallLog = mongoose.model("AiCallLog", aiCallLogSchema);

module.exports = AiCallLog;
