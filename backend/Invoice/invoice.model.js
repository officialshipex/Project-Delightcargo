const mongoose = require("mongoose");

const InvoicePaymentSchema = new mongoose.Schema({
  amount: Number,
  paymentMode: String,
  transactionId: String,
  date: { type: Date, default: Date.now },
  note: String
}, { _id: false });

const InvoiceSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

  periodStart: Date,
  periodEnd: Date,

  invoiceNumber: { type: String, required: true },

  totalAmount: { type: Number, required: true }, // taxable + tax
  taxableValue: { type: Number, required: true },
  tax: { type: Number, required: true },

  paidAmount: { type: Number, default: 0 },
  dueAmount: { type: Number, default: 0 },

  status: {
    type: String,
    enum: ['PAID','UNPAID','PARTIALLY_PAID'],
    default: 'UNPAID'
  },

  chargesBreakup: Object,   // including all txns used
  paymentHistory: [InvoicePaymentSchema],

  /* NEW IMPORTANT FIELDS */
  includedAwbs: [String],   // prevent duplicate billing
  s3Url: String,            // store AWS invoice URL
  isFinalized: { type: Boolean, default: false } // lock invoice after generation

}, { timestamps: true });

module.exports = mongoose.model("Invoice", InvoiceSchema);
