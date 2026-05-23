const mongoose = require("mongoose");

const afterPlanSchema=new mongoose.Schema({

    date: { type: Date },
    deliveryDate: { type: Date },
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
    
    adjustedAmount: { type: Number },
    amountCreditedToWallet:{type:Number},
    earlyCodCharges: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ["Pending", "Paid"],
      default: "Pending",
    },
    orderDetails: {
      date: { type: Date, required: true },
      codcal: { type: Number },
      orders: [{ type: mongoose.Schema.Types.ObjectId, ref: "Order" }],
    },
  
})
const afterPlan = mongoose.model("afterPlan", afterPlanSchema);
module.exports = afterPlan;

