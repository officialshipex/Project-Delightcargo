const mongoose = require("mongoose");

const activityLogSchema = new mongoose.Schema(
  {
    performedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    action: {
      type: String, // "ADD", "EDIT", "DELETE", "UPLOAD"
      required: true,
    },
    module: {
      type: String, // "RATE_CARD"
      required: true,
    },
    details: {
      type: mongoose.Schema.Types.Mixed,
    },
    planName: {
      type: String,
    },
    timestamp: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("ActivityLog", activityLogSchema);
