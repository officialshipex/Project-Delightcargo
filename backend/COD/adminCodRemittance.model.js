const mongoose = require("mongoose");

const adminCodRemittance = new mongoose.Schema(
  {
    date: { type: Date },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    userName: {
      type: String,
    },
    remitanceId: {
      type: String,
    },
    totalCod: {
      type: Number,
    },

     amountCreditedToWallet: { type: Number, },
      earlyCodCharges: { type: Number, default: 0 },
      adjustedAmount: { type: Number },
    status: {
      type: String,
      enum: ["Pending", "Paid"],
      default: "Pending",
    },
    reason:{type:String},
    orderDetails: {
      date: { type: Date, required: true },
      codcal: { type: Number },
      orders: [{ type: mongoose.Schema.Types.ObjectId, ref: "Order" }],
    },
  },
  { timestamps: true }
);

const CODRemittance = mongoose.model("adminCodRemittance", adminCodRemittance);
module.exports = CODRemittance;
