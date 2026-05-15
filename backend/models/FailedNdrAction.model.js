const mongoose = require("mongoose");

const failedNdrActionSchema = new mongoose.Schema(
  {
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "newOrder",
      required: true,
    },
    awb_number: {
      type: String,
      required: true,
    },
    action: {
      type: String,
      required: true,
    },
    payload: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
    retryCount: {
      type: Number,
      default: 0,
    },
    status: {
      type: String,
      enum: ["pending", "completed", "failed"],
      default: "pending",
    },
    lastError: {
      type: String,
    },
    lastAttemptAt: {
      type: Date,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("FailedNdrAction", failedNdrActionSchema);
