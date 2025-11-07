const mongoose = require("mongoose");

const messageLogSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      //   required: true,
    },
    awb_number: {
      type: String,
      //   required: true,
      trim: true,
    },
    status: {
      type: String,
      //   required: true,
      trim: true,
    },
    isEmailSent: {
      type: Boolean,
      default: false,
    },
    isWhatsAppSent: {
      type: Boolean,
      default: false,
    },
    isSMSSent: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true, // ✅ Automatically adds createdAt & updatedAt
  }
);

module.exports = mongoose.model("MessageLog", messageLogSchema);
