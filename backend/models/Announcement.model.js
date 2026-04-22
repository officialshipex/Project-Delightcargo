const mongoose = require("mongoose");

const announcementSchema = new mongoose.Schema(
  {
    message: {
      type: String,
      required: true,
    },
    enabled: {
      type: Boolean,
      default: true,
    },
    targetAudience: {
      type: String,
      enum: ["all", "selected"],
      default: "all",
    },
    selectedUsers: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],
    disableType: {
      type: String,
      enum: ["manual", "automated"],
      default: "manual",
    },
    automatedDuration: {
      type: String, // "1h", "1d", "5d", "custom"
      default: null,
    },
    automatedDisableUntil: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Announcement", announcementSchema);
