const mongoose = require("mongoose");

const invoiceCounterSchema = new mongoose.Schema({
  key: { type: String, unique: true }, // e.g. SFC2324
  seq: { type: Number, default: 0 },
});

module.exports = mongoose.model("InvoiceCounter", invoiceCounterSchema);
