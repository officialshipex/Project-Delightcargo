const mongoose = require("mongoose");

const weightDiscrepancySchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    awbNumber: { type: String, required: true, unique: true }, // Tracking Number
    orderId: { type: Number, required: true }, // Order ID
    productDetails: [
      {
        id: Number,
        quantity: Number,
        name: String,
        sku: String,
        unitPrice: String,
      },
    ], // Product Details
    courierServiceName: { type: String, required: true }, // Courier Service Name
    provider: { type: String, required: true }, // Provider Name
    enteredWeight: {
      applicableWeight: { type: String, required: true },
      deadWeight: { type: String, required: true },
      volumetricWeight:{
        length:{type:String},
        breadth:{type:String},
        height:{type:String}
      }
    }, // Weight from Order Data
    chargedWeight: {
      applicableWeight: { type: String, required: true },
      deadWeight: { type: String, required: true },
    },
    chargeDimension: {
      length: { type: String },
      breadth: { type: String },
      height: { type: String },
    },
    excessWeightCharges: {
      excessWeight: { type: String, required: true },
      excessCharges: { type: String, required: true },
      pendingAmount: { type: String, required: true },
      priceBreakup: { type: Object },
    }, // Weight from Uploaded File
    status: { type: String, required: true },
    clientStatus: { type: String },

    adminStatus: { type: String, required: true },
    imageUrl: { type: String },
    text: { type: String },
    discrepancyRaisedAt: { type: Date }, 
    discrepancyAcceptedAt: { type: Date },
    discrepancyDeclinedReason: { type: String },
    discrepancyDeclinedAt: { type: Date }
  },
  { timestamps: true }
);

module.exports = mongoose.model("WeightDiscrepancy", weightDiscrepancySchema);
