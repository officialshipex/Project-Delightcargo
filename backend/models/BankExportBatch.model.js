const mongoose = require("mongoose");

const batchRowSchema = new mongoose.Schema({
  remittanceId: { type: String, required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  beneficiaryAccount: { type: String, required: true },
  amount: { type: Number, required: true },
}, { _id: false });

const BankExportBatchSchema = new mongoose.Schema({
  batchId: { type: String, required: true, unique: true },
  exportedAt: { type: Date, default: Date.now },
  rows: [batchRowSchema],
  totalRows: { type: Number },
  status: { type: String, enum: ["Active", "Processed"], default: "Active" },
});

module.exports = mongoose.model("BankExportBatch", BankExportBatchSchema);
