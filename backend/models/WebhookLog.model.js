const mongoose = require("mongoose");

const webhookLogSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    webhookId: {
      type: String,
      required: true,
    },
    url: {
      type: String,
      required: true,
    },
    eventTopic: {
      type: String,
      required: true,
    },
    httpStatus: {
      type: Number,
    },
    status: {
      type: String,
      enum: ["Success", "Failure"],
      required: true,
    },
    payload: {
      type: mongoose.Schema.Types.Mixed,
    },
    response: {
      type: mongoose.Schema.Types.Mixed,
    },
    responseTime: {
      type: Number, // in ms
    },
    timestamp: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

const WebhookLog = mongoose.model("WebhookLog", webhookLogSchema);

module.exports = WebhookLog;
