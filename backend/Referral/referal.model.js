// models/ReferralMonthlyStat.js
const mongoose =require("mongoose");

const SubUserStatSchema = new mongoose.Schema({
  subUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  subUserName: { type: String }, // optional, if you want to store snapshot
  orderCount: { type: Number, default: 0 },
  totalShipping: { type: Number, default: 0 },
  commission: { type: Number, default: 0 },
  orderIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Order" }],
});

const ReferralMonthlyStatSchema = new mongoose.Schema({
  month: { type: Number, required: true }, // 1-12
  year: { type: Number, required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }, // parent user
  totalOrderCount: { type: Number, default: 0 },
  totalShipping: { type: Number, default: 0 },
  totalCommission: { type: Number, default: 0 },
  perSubUser: [SubUserStatSchema],
  generatedAt: { type: Date, default: Date.now },
  // keep monthly tracking history if needed
  trackingHistory: [
    {
      date: Date,
      orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order" },
      status: String,
      statusDateTime: Date,
    },
  ],
});

const ReferralMonthlyStat = mongoose.model("ReferralMonthlyStat", ReferralMonthlyStatSchema);
module.exports=ReferralMonthlyStat;
