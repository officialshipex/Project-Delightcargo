const mongoose = require("mongoose");

const weightSchema = new mongoose.Schema({
  weight: { type: Number, required: true },
  zoneA: { type: Number, required: true },
  zoneB: { type: Number, required: true },
  zoneC: { type: Number, required: true },
  zoneD: { type: Number, required: true },
  zoneE: { type: Number, required: true },
});

const costingRateCardSchema = new mongoose.Schema(
  {
    courierServiceName: { type: String, required: true, unique: true },
    mode: { type: String, required: false },
    status: { type: String, enum: ["Active", "Inactive"], required: true, default: "Active" },
    shipmentType: { type: String, enum: ["Forward", "Reverse"], required: true, default: "Forward" },
    weightPriceBasic: [weightSchema],
    weightPriceAdditional: [weightSchema],
    codPercent: { type: Number, required: true },
    codCharge: { type: Number, required: true },
  },
  { timestamps: true }
);

const CostingRateCard = mongoose.model("CostingRateCard", costingRateCardSchema);
module.exports = CostingRateCard;
