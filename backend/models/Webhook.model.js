const mongoose = require("mongoose");

const webhookSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    webhookId: {
      type: String,
      unique: true,
      required: true,
    },
    url: {
      type: String,
      required: true,
    },
    secret: {
      type: String,
      required: true,
    },
    topics: {
      type: [String],
      required: true,
    },
    alertEmail: {
      type: String,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

const Webhook = mongoose.model("Webhook", webhookSchema);

module.exports = Webhook;
