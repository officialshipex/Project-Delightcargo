const mongoose = require("mongoose");

const ReferralWithdrawalSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    amount: { type: Number, required: true },
    status: { type: String, enum: ["Success", "Pending", "Failed"], default: "Success" },
    description: { type: String, default: "Referral Commission Transfer to Wallet" },
  },
  { timestamps: true }
);

const ReferralWithdrawal = mongoose.model("ReferralWithdrawal", ReferralWithdrawalSchema);
module.exports = ReferralWithdrawal;
