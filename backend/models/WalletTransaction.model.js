const mongoose = require("mongoose");

/**
 * Standalone WalletTransaction collection.
 *
 * Previously transactions were embedded in the Wallet document as an array.
 * As users accumulate orders (200 → 2000+), that array grows the wallet
 * document from ~50KB to 500KB+, making every $push slower because MongoDB
 * must read-modify-write the entire document.
 *
 * This separate collection keeps each transaction as its own small document
 * (~500 bytes), making writes O(1) regardless of user history size.
 */
const walletTransactionSchema = new mongoose.Schema(
  {
    walletId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Wallet",
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    channelOrderId: { type: String },
    category: { type: String, enum: ["credit", "debit"], required: true },
    amount: { type: Number, required: true },
    balanceAfterTransaction: { type: Number },
    date: { type: Date, default: Date.now },
    awb_number: { type: String },
    description: { type: String },
    priceBreakup: { type: Object },
  },
  { timestamps: true }
);

// Compound index for efficient user-level queries (passbook, billing history)
walletTransactionSchema.index({ walletId: 1, createdAt: -1 });
walletTransactionSchema.index({ userId: 1, createdAt: -1 });
walletTransactionSchema.index({ awb_number: 1 });

const WalletTransaction = mongoose.model("WalletTransaction", walletTransactionSchema);

module.exports = WalletTransaction;
