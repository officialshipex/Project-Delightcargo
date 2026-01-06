const mongoose = require("mongoose");

const RateCellSchema = new mongoose.Schema(
  {
    fromZone: String,
    toZone: String,
    price: Number,
  },
  { _id: false }
);

/* ================= OVERHEAD CHARGES ================= */
const OverheadSchema = new mongoose.Schema(
  {
    type: {
      type: String, // percentage | perKg | flat | formula
    },
    value: mongoose.Schema.Types.Mixed, // number | string
    min: Number, // optional
  },
  { _id: false }
);

const RateCardSchema = new mongoose.Schema(
  {
    courierService: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "B2BCourierService",
      required: true,
    },
    courierServiceName: {
      type: String,
      required: true,
    },
    courierProviderName: {
      type: String,
    },
    plan: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Plan",
      required: true,
    },
    planName: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active",
    },
    rates: [RateCellSchema],
    /* ===== OVERHEAD CHARGES ===== */
    
    overheadCharges: {
      pickupCharge: OverheadSchema,
      handlingCharge: OverheadSchema,
      codCharges: OverheadSchema,
      fodCharges: OverheadSchema,

      rovOwner: OverheadSchema,
      rovCarrier: OverheadSchema,

      odaCharges: OverheadSchema,
      fuelCharge: OverheadSchema,

      docketCharge: OverheadSchema,
      appointmentDelivery: OverheadSchema,
      greenTax: OverheadSchema,

      divisor: OverheadSchema,
      minimumFreight: OverheadSchema,

      gst: OverheadSchema,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true }
);

// 🔒 Prevent duplicate courier + plan
RateCardSchema.index({ courierService: 1, plan: 1 }, { unique: true });

module.exports = mongoose.model("B2BRateCard", RateCardSchema);
