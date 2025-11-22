
// invoice.model.js
const InvoicePaymentSchema = new mongoose.Schema({
  amount: Number,
  paymentMode: String,
  transactionId: String,
  date: { type: Date, default: Date.now },
  note: String
}, { _id: false });

export const InvoiceSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  periodStart: Date,
  periodEnd: Date,
  invoiceNumber: { type: String, required: true },
  totalAmount: { type: Number, required: true }, // taxable + tax
  taxableValue: { type: Number, required: true },
  tax: { type: Number, required: true },
  paidAmount: { type: Number, default: 0 },
  dueAmount: { type: Number, default: 0 },
  status: { type: String, enum: ['PAID','UNPAID','PARTIALLY_PAID'], default: 'UNPAID' },
  chargesBreakup: Object, // optional detailed breakup
  paymentHistory: [InvoicePaymentSchema]
}, { timestamps: true });

export const Invoice = mongoose.model('Invoice', InvoiceSchema);

/* -------------------------
   UTIL: Invoice Number Generator
   -------------------------*/
export function generateInvoiceNumber(prefix = 'INV'){
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth()+1).padStart(2,'0');
  const d = String(now.getDate()).padStart(2,'0');
  const random = Math.floor(1000 + Math.random()*9000);
  return `${prefix}-${y}${m}${d}-${random}`;
}

/* -------------------------
   CONTROLLERS
   -------------------------*/

// invoice.controller.js
import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import { Wallet } from './wallet.model.js';
import { Invoice } from './invoice.model.js';
import { CodLedger } from './cod.model.js';
import mongoose from 'mongoose';

// Helper: calculate GST (18%)
const GST_RATE = 0.18;

async function buildChargesFromWalletTransactions(userId, periodStart, periodEnd){
  const wallet = await Wallet.findOne({ userId });
  if (!wallet) throw new Error('Wallet not found');

  // Filter transactions in period and only service charges (debits)
  const txns = wallet.transactions.filter(t => {
    const d = new Date(t.date);
    return d >= periodStart && d <= periodEnd && t.category === 'debit';
  });

  // Sum taxable value: we consider all debit amounts as taxable service charges
  const taxableValue = txns.reduce((s,t)=> s + Number(t.amount || 0), 0);
  const tax = Number((taxableValue * GST_RATE).toFixed(2));
  const total = Number((taxableValue + tax).toFixed(2));

  return { taxableValue, tax, total, txns };
}

// Generate PDF invoice using PDFKit. Uses sample logo from uploaded file path.
export async function generateInvoicePDF(invoice){
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 40 });

      const fileName = `invoice-${invoice.invoiceNumber}.pdf`;
      const outPath = path.join('/mnt/data', fileName); // saved to /mnt/data
      const stream = fs.createWriteStream(outPath);
      doc.pipe(stream);

      // Header
      const logoPath = '/mnt/data/Screenshot 2025-11-21 174349.png'; // sample logo/image (from your upload)
      if (fs.existsSync(logoPath)) doc.image(logoPath, 40, 30, { width: 120 });

      doc.fontSize(16).text('TAX INVOICE', 420, 40, { align: 'right' });
      doc.moveDown();

      // Invoice meta
      doc.fontSize(10).text(`Invoice No: ${invoice.invoiceNumber}`);
      doc.text(`Invoice Date: ${invoice.createdAt.toISOString().split('T')[0]}`);
      doc.text(`Period: ${invoice.periodStart.toISOString().split('T')[0]} to ${invoice.periodEnd.toISOString().split('T')[0]}`);

      doc.moveDown();

      // Bill To
      doc.fontSize(12).text('Bill To:', { underline: true });
      doc.fontSize(10).text(`User ID: ${invoice.userId}`);

      doc.moveDown();

      // Charges table (simple)
      doc.fontSize(10).text('Charges Summary', { underline: true });
      doc.moveDown(0.3);

      doc.text(`Taxable Value: ₹${invoice.taxableValue.toFixed(2)}`);
      doc.text(`GST @18%: ₹${invoice.tax.toFixed(2)}`);
      doc.moveDown(0.2);
      doc.fontSize(12).text(`Grand Total: ₹${invoice.totalAmount.toFixed(2)}`, { bold: true });

      doc.moveDown(1);

      // Payment section
      doc.fontSize(10).text('Payment Summary', { underline: true });
      doc.moveDown(0.3);
      doc.text(`Paid Amount: ₹${invoice.paidAmount.toFixed(2)}`);
      doc.text(`Due Amount: ₹${invoice.dueAmount.toFixed(2)}`);
      doc.text(`Status: ${invoice.status}`);

      doc.end();

      stream.on('finish', ()=> resolve(outPath));
      stream.on('error', reject);
    } catch (err) {
      reject(err);
    }
  });
}

// Controller: generate monthly invoice & auto-apply wallet
export const generateMonthlyInvoice = async (req, res) => {
  try {
    const { userId } = req.params;

    // Determine month window (previous month or current month - choose as per requirement)
    // For demo we'll use first day of current month to last day of current month
    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const periodEnd = new Date(now.getFullYear(), now.getMonth()+1, 0, 23,59,59,999);

    // Build charges from wallet txns
    const { taxableValue, tax, total, txns } = await buildChargesFromWalletTransactions(userId, periodStart, periodEnd);

    // Create invoice
    const invoiceNumber = generateInvoiceNumber();
    const invoice = new Invoice({
      userId,
      periodStart,
      periodEnd,
      invoiceNumber,
      totalAmount: total,
      taxableValue,
      tax,
      paidAmount: 0,
      dueAmount: total,
      chargesBreakup: { transactionsCount: txns.length }
    });

    // Auto-apply wallet balance
    const wallet = await Wallet.findOne({ userId });
    if (!wallet) throw new Error('Wallet not found');

    const available = Number(wallet.balance || 0);
    const toDeduct = Math.min(available, invoice.dueAmount);

    if (toDeduct > 0) {
      // update invoice
      invoice.paidAmount = Number((invoice.paidAmount + toDeduct).toFixed(2));
      invoice.dueAmount = Number((invoice.totalAmount - invoice.paidAmount).toFixed(2));
      invoice.status = invoice.dueAmount === 0 ? 'PAID' : 'PARTIALLY_PAID';

      // wallet transaction
      wallet.balance = Number((wallet.balance - toDeduct).toFixed(2));
      wallet.transactions.push({
        category: 'debit',
        amount: toDeduct,
        balanceAfterTransaction: wallet.balance,
        date: new Date(),
        description: `Auto deduction for invoice ${invoice.invoiceNumber}`
      });

      // record payment history on invoice
      invoice.paymentHistory.push({ amount: toDeduct, paymentMode: 'Wallet', transactionId: `WAL-${Date.now()}`, date: new Date(), note: 'Auto-applied wallet' });
    }

    // finalize due and status if no auto deduct
    if (!invoice.status) {
      invoice.status = invoice.paidAmount === 0 ? 'UNPAID' : 'PARTIALLY_PAID';
    }

    await invoice.save();
    await wallet.save();

    // generate PDF and return path
    const pdfPath = await generateInvoicePDF(invoice);

    return res.json({ success: true, invoice, pdfPath });
  } catch (err) {
    console.error('generateMonthlyInvoice error', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// Controller: Manual payment for invoice (bank/UPI/other)
export const payInvoiceManually = async (req, res) => {
  try {
    const { invoiceId, amount, paymentMode, transactionId } = req.body;

    const invoice = await Invoice.findById(invoiceId);
    if (!invoice) return res.status(404).json({ message: 'Invoice not found' });

    const payAmt = Number(amount || 0);
    if (payAmt <= 0) return res.status(400).json({ message: 'Invalid amount' });

    // create payment entry
    invoice.paymentHistory.push({ amount: payAmt, paymentMode, transactionId, date: new Date(), note: 'Manual payment' });
    invoice.paidAmount = Number((invoice.paidAmount + payAmt).toFixed(2));
    invoice.dueAmount = Number(Math.max(0, invoice.totalAmount - invoice.paidAmount).toFixed(2));
    invoice.status = invoice.dueAmount === 0 ? 'PAID' : 'PARTIALLY_PAID';

    await invoice.save();

    // Optionally, if paymentMode means wallet top-up, reflect into wallet
    if (paymentMode === 'Wallet-Recharge'){
      const wallet = await Wallet.findOne({ userId: invoice.userId });
      if (wallet) {
        wallet.balance = Number((wallet.balance + payAmt).toFixed(2));
        wallet.transactions.push({ category: 'credit', amount: payAmt, balanceAfterTransaction: wallet.balance, date: new Date(), description: `Wallet recharge for invoice ${invoice.invoiceNumber}` });
        await wallet.save();

        // After wallet credit, attempt to auto-apply remaining due
        if (invoice.dueAmount > 0) {
          const apply = Math.min(wallet.balance, invoice.dueAmount);
          if (apply > 0) {
            wallet.balance = Number((wallet.balance - apply).toFixed(2));
            wallet.transactions.push({ category: 'debit', amount: apply, balanceAfterTransaction: wallet.balance, date: new Date(), description: `Auto applied to invoice ${invoice.invoiceNumber}` });

            invoice.paidAmount = Number((invoice.paidAmount + apply).toFixed(2));
            invoice.dueAmount = Number(Math.max(0, invoice.totalAmount - invoice.paidAmount).toFixed(2));
            invoice.paymentHistory.push({ amount: apply, paymentMode: 'Wallet', transactionId: `WAL-${Date.now()}`, date: new Date(), note: 'Auto-applied after recharge' });
            invoice.status = invoice.dueAmount === 0 ? 'PAID' : 'PARTIALLY_PAID';

            await invoice.save();
            await wallet.save();
          }
        }
      }
    }

    return res.json({ success: true, invoice });
  } catch (err) {
    console.error('payInvoiceManually', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};


/* -------------------------
   CRON: Monthly Invoice Generation (example using node-cron)
   -------------------------*/

// cron.job.js
import cron from 'node-cron';

export function scheduleMonthlyInvoiceGeneration(generateFn){
  // Run on 1st day of month at 01:00 AM server time
  cron.schedule('0 1 1 * *', async () => {
    console.log('Running monthly invoice generation cron...');
    try {
      // generateFn should iterate users and call generation for each
      await generateFn();
    } catch (err) {
      console.error('Monthly invoice cron error', err);
    }
  });
}

