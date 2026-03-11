const mongoose = require("mongoose");

const pickupManifestSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    pickupId: {
      type: String,
      required: true,
      index: true,
    },

    providers: {
      type: [String],
      default: [],
    },

    // Single provider — used for grouping manifests by courier
    provider: {
      type: String,
      default: null,
    },

    courierServiceNames: {
      type: [String],
      default: [],
    },

    pickupDate: {
      type: Date,
      required: true,
    },

    status: {
      type: String,
      enum: ["Pickup_Scheduled"],
      default: "Pickup_Scheduled",
    },

    orderIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "newOrder",
      },
    ],

    awb_numbers: {
      type: [String],
      default: [],
    },

    orderType: {
      type: String,
      enum: ["B2C", "B2B"],
      default: "B2C",
    },
    pickupAddress: {
      type: Object,
      default: null,
    },
  },
  { timestamps: true }
);

// Compound index: one manifest per user + date + provider + pickup address
pickupManifestSchema.index({ userId: 1, pickupDate: 1, provider: 1 });

module.exports = mongoose.model("PickupManifest", pickupManifestSchema);
