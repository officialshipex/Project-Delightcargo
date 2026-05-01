const mongoose = require("mongoose");

const weightSchema = new mongoose.Schema({
  weight: {
    type: Number,
    required: true,
  },
  zoneA: {
    type: Number,
    required: true,
  },
  zoneB: {
    type: Number,
    required: true,
  },
  zoneC: {
    type: Number,
    required: true,
  },
  zoneD: {
    type: Number,
    required: true,
  },
  zoneE: {
    type: Number,
    required: true,
  },
});

const rateCardSchema = new mongoose.Schema({
  plan: {
    type: String,
    required: true,
  },
  mode: {
    type: String,
    required: false,
  },
  courierProviderName: {
    type: String,
    required: true,
  },
  courierName: {
    type: String,
    required: false,
  },
  courierServiceName: {
    type: String,
    required: true,
  },
  courierProviderId: {
    type: String,
  },
  courierServiceId: {
    type: String,
  },
  weightPriceBasic: [weightSchema], // Array of weight schemas for the basic rate
  weightPriceAdditional: [weightSchema], // Array of weight schemas for the additional rate
  isFlatRate: {
    type: Boolean,
    default: false,
  },
  codPercent: {
    type: Number,
    required: false,
    default: 0,
  },
  codCharge: {
    type: Number,
    required: false,
    default: 0,
  },
  gst: {
    type: Number,
  },
  defaultRate: {
    type: Boolean,
    default: false,
  },
  status: {
    type: String,
    enum: ["Active", "Inactive"],
    required: true,
  },
  shipmentType: {
    type: String,
    enum: ["Forward", "Reverse"],
    required: true,
  },
});

const RateCard = mongoose.model("RateCard", rateCardSchema);

module.exports = RateCard;
