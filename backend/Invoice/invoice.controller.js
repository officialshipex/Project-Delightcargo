// controllers/invoice.controller.js
const mongoose = require("mongoose");
const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");
const { uploads, s3 } = require("../config/s3");
const cron = require("node-cron");
const { PutObjectCommand } = require("@aws-sdk/client-s3");

const Wallet = require("../models/wallet"); // adjust path
const Order = require("../models/newOrder.model"); // adjust path
const Invoice = require("./invoice.model"); // adjust path
const User = require("../models/User.model"); // adjust path

const GST_RATE = 0.18;

// Prefer transaction.awb_number, fallback to regex on description
function extractAwbFromTransaction(txn) {
  if (!txn) return null;
  if (txn.awb_number && String(txn.awb_number).trim() !== "")
    return String(txn.awb_number).trim();

  const desc = String(txn.description || "");
  // Try common AWB patterns: numbers of length >=6, or with prefixes
  // e.g. "AWB: 35973710025970", "AWB#35973710025970", "awb 35973710025970"
  const awbRegex =
    /(?:AWB[:#\s-]*|awb[:#\s-]*|awb_number[:#\s-]*|awb no[:#\s-]*|awb#[:#\s-]*|awb-)([A-Za-z0-9-]{6,})/i;
  let m = desc.match(awbRegex);
  if (m && m[1]) return m[1];

  // fallback: find first long numeric token (>=6 digits)
  const numFallback = desc.match(/\b(\d{6,})\b/);
  if (numFallback) return numFallback[1];

  return null;
}

function allowedDescription(desc = "") {
  if (!desc) return false;
  const normalized = desc.trim().toLowerCase();
  const allowed = [
    "freight charges applied",
    "rto freight charges applied",
    "auto-accepted weight dispute charge",
    "weight dispute charges applied",
  ];
  return allowed.includes(normalized);
}

// Generate invoice number
function generateInvoiceNumber(prefix = "SHI") {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const random = Math.floor(1000 + Math.random() * 9000);
  return `${prefix}-${y}${m}${d}-${random}`;
}

// PDF generation with clean layout and AWB table
async function generateInvoicePDF(invoice, userDetails = {}) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 40 });
      const fileName = `invoice-${invoice.invoiceNumber}.pdf`;
      const outPath = path.join(
        process.env.INVOICE_LOCAL_TMP || "/tmp",
        fileName
      );
      const stream = fs.createWriteStream(outPath);
      doc.pipe(stream);

      // Header: Company (left) + TAX INVOICE (right)
      doc.fontSize(14).text(userDetails.companyName || "Your Company Name", {
        align: "left",
      });
      doc.fontSize(18).text("TAX INVOICE", { align: "right" });
      doc.moveDown(0.5);

      // Invoice meta
      doc.fontSize(10);
      doc.text(`Invoice No: ${invoice.invoiceNumber}`);
      doc.text(
        `Invoice Date: ${invoice.createdAt.toISOString().split("T")[0]}`
      );
      doc.text(
        `Period: ${invoice.periodStart.toISOString().split("T")[0]} to ${
          invoice.periodEnd.toISOString().split("T")[0]
        }`
      );
      doc.moveDown(0.8);

      // Bill To
      doc.fontSize(12).text("Bill To:", { underline: true });
      doc.fontSize(10);
      doc.text(`User ID: ${invoice.userId}`);
      if (userDetails.fullname) doc.text(`Name: ${userDetails.fullname}`);
      if (userDetails.email) doc.text(`Email: ${userDetails.email}`);
      if (userDetails.company) doc.text(`Company: ${userDetails.company}`);
      doc.moveDown(0.8);

      // Charges table header
      doc.fontSize(11).text("Charges Summary", { underline: true });
      doc.moveDown(0.3);

      // Table columns: AWB | Description | Amount
      const tableTop = doc.y;
      const colWidths = { awb: 160, desc: 260, amt: 100 };
      doc
        .fontSize(10)
        .text("AWB", 40, tableTop, { width: colWidths.awb, continued: true })
        .text("Description", 40 + colWidths.awb, tableTop, {
          width: colWidths.desc,
          continued: true,
        })
        .text("Amount (₹)", 40 + colWidths.awb + colWidths.desc, tableTop, {
          width: colWidths.amt,
          align: "right",
        });

      doc.moveDown(0.2);
      doc.moveTo(40, doc.y).lineTo(550, doc.y).stroke();

      // Rows
      let y = doc.y + 6;
      const rowsPerPage = 35;
      let rowCount = 0;
      const txns = invoice.chargesBreakup?.transactions || [];

      for (const t of txns) {
        if (rowCount && rowCount % rowsPerPage === 0) {
          doc.addPage();
          y = 60;
        }
        const awbText = t.awb || "";
        const descText = t.description || "";
        const amtText = Number(t.amount || 0).toFixed(2);

        doc
          .fontSize(10)
          .text(awbText, 40, y, { width: colWidths.awb })
          .text(descText, 40 + colWidths.awb, y, { width: colWidths.desc })
          .text(amtText, 40 + colWidths.awb + colWidths.desc, y, {
            width: colWidths.amt,
            align: "right",
          });

        y += 18;
        rowCount++;
      }

      doc.moveDown(1);
      doc.moveTo(40, y).lineTo(550, y).stroke();
      y += 8;

      // Totals and GST
      doc
        .fontSize(10)
        .text(
          `Taxable Value: ₹${Number(invoice.taxableValue).toFixed(2)}`,
          40,
          y
        );
      y += 14;
      doc.text(`GST @18%: ₹${Number(invoice.tax).toFixed(2)}`, 40, y);
      y += 14;
      doc
        .fontSize(12)
        .text(`Grand Total: ₹${Number(invoice.totalAmount).toFixed(2)}`, 40, y);
      y += 18;

      // Payment summary
      doc.moveDown(0.5);
      doc.fontSize(10).text("Payment Summary", 40, y);
      doc.moveDown(0.3);
      doc.text(`Paid Amount: ₹${Number(invoice.paidAmount).toFixed(2)}`);
      doc.text(`Due Amount: ₹${Number(invoice.dueAmount).toFixed(2)}`);
      doc.text(`Status: ${invoice.status}`);
      doc.moveDown(1);

      // Footer
      doc
        .fontSize(9)
        .text(
          "This invoice is computer generated and does not require signature.",
          40,
          doc.page.height - 60,
          { align: "center" }
        );

      doc.end();

      stream.on("finish", () => resolve(outPath));
      stream.on("error", (err) => reject(err));
    } catch (err) {
      reject(err);
    }
  });
}

// Upload to S3 and return public URL
async function uploadToS3(localPath, key) {
  const fileContent = fs.readFileSync(localPath);

  await s3.send(
    new PutObjectCommand({
      Bucket: process.env.AWS_BUCKET_NAME, // from your existing config
      Key: key,
      Body: fileContent,
      ContentType: "application/pdf",
      ACL: "private", // or remove if your bucket blocks ACL
    })
  );

  return `https://${process.env.AWS_BUCKET_NAME}.s3.${
    process.env.AWS_REGION
  }.amazonaws.com/${encodeURIComponent(key)}`;
}

/* -------------------------
   Core: Build charges using wallet transactions (allowed descriptions)
   -------------------------*/
async function buildChargesFromWalletTransactions(
  userId,
  periodStart,
  periodEnd,
  previousAwbs = []
) {
  const wallet = await Wallet.findOne({ userId });
  if (!wallet) return { taxableValue: 0, tax: 0, total: 0, txns: [] };

  // Filter debit txns in period with allowed descriptions
  const candidateTxns = (wallet.transactions || []).filter((t) => {
    if (!t) return false;
    const d = new Date(t.date);
    if (d < periodStart || d > periodEnd) return false;
    if ((t.category || "").toLowerCase() !== "debit") return false;
    if (!allowedDescription(t.description)) return false;
    return true;
  });

  const validTxns = [];

  // Validate each txn using AWB -> check Order status and skip duplicates (previousAwbs)
  for (const t of candidateTxns) {
    const awb = extractAwbFromTransaction(t);
    if (!awb) continue;

    // Skip if already invoiced previously
    if (previousAwbs.includes(awb)) continue;

    const order = await Order.findOne({ awb_number: awb }).select(
      "status awb_number"
    );
    if (!order) continue; // if order missing, skip (safe)
    const st = (order.status || "").toLowerCase();
    if (st === "new" || st === "cancelled") continue;

    // If passes all checks, include
    validTxns.push({
      awb,
      description: t.description,
      amount: Number(t.amount || 0),
      date: t.date,
      channelOrderId: t.channelOrderId || null,
    });
  }

  const taxableValue = validTxns.reduce((s, x) => s + x.amount, 0);
  const tax = Number((taxableValue * GST_RATE).toFixed(2));
  const total = Number((taxableValue + tax).toFixed(2));

  return { taxableValue, tax, total, txns: validTxns };
}

/* -------------------------
   Controller: Generate monthly invoice for single user
   -------------------------*/

async function generateInvoiceForUserMonth(userId, periodStart, periodEnd) {
  const prevInvoices = await Invoice.find({ userId }, { includedAwbs: 1 });
  const prevAwbs = prevInvoices.flatMap((i) => i.includedAwbs || []);

  const { taxableValue, tax, total, txns } =
    await buildChargesFromWalletTransactions(
      userId,
      periodStart,
      periodEnd,
      prevAwbs
    );

  if (!txns || txns.length === 0) {
    return { skipped: true, reason: "No chargeable transactions" };
  }

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
    chargesBreakup: { transactionsCount: txns.length, transactions: txns },
    includedAwbs: txns.map((t) => t.awb),
    status: "UNPAID",
  });

  const wallet = await Wallet.findOne({ userId });
  if (!wallet) {
    await invoice.save();
    return { saved: true, invoice, applied: 0, note: "Wallet not found" };
  }

  const available = Number(wallet.balance || 0);
  const toDeduct = Math.min(available, invoice.dueAmount);

  if (toDeduct > 0) {
    invoice.paidAmount = Number((invoice.paidAmount + toDeduct).toFixed(2));
    invoice.dueAmount = Number(
      (invoice.totalAmount - invoice.paidAmount).toFixed(2)
    );
    invoice.status = invoice.dueAmount === 0 ? "PAID" : "PARTIALLY_PAID";

    wallet.balance = Number((wallet.balance - toDeduct).toFixed(2));
    wallet.transactions.push({
      category: "debit",
      amount: toDeduct,
      balanceAfterTransaction: wallet.balance,
      date: new Date(),
      description: `Auto deduction for invoice ${invoice.invoiceNumber}`,
    });

    invoice.paymentHistory.push({
      amount: toDeduct,
      paymentMode: "Wallet",
      transactionId: `WAL-${Date.now()}`,
      date: new Date(),
      note: "Auto-applied wallet",
    });

    await wallet.save();
  }

  await invoice.save();

  // PDF build
  const user = await User.findById(userId).select("fullname email company");
  const pdfPath = await generateInvoicePDF(invoice, {
    fullname: user?.fullname,
    email: user?.email,
    companyName: user?.company || "Your Company Name",
  });

  const s3Key = `invoices/${userId}/${invoice.invoiceNumber}.pdf`;

  const s3Url = await uploadToS3(pdfPath, s3Key);

  invoice.s3Url = s3Url;
  invoice.isFinalized = true;
  await invoice.save();

  try {
    fs.unlinkSync(pdfPath);
  } catch (e) {}

  return { saved: true, invoice, s3Url, applied: toDeduct || 0 };
}

/* -------------------------
   Bulk: Generate invoices for all users for a given period
   -------------------------*/
async function generateInvoicesForPeriod(periodStart, periodEnd) {
  // Fetch all users who have wallet or active users (change criteria as needed)
  // const users = await User.find({}, { _id: 1 });
  const users=await User.findOne({userId:17333})

  const results = [];
  for (const u of users) {
    try {
      const r = await generateInvoiceForUserMonth(
        u._id,
        periodStart,
        periodEnd
      );
      results.push({ userId: u._id.toString(), result: r });
    } catch (err) {
      results.push({ userId: u._id.toString(), error: err.message });
    }
  }
  return results;
}

/* -------------------------
   Cron: run daily at 23:59 and trigger generation if tomorrow is 1st (i.e. last day behavior)
   -------------------------*/
async function scheduleMonthlyInvoiceCron() {
  // Runs at 23:59 server time every day
  // cron.schedule("59 23 * * *", async () => {
    console.log("Running monthly invoice cron check...");
    try {
      const now = new Date();
      const tomorrow = new Date(now);
      tomorrow.setDate(now.getDate() + 1);
      if (tomorrow.getDate() !== 1) {
        // not month-end
        return;
      }

      // generate for current month (i.e. month that just finished)
      const year = now.getFullYear();
      const month = now.getMonth(); // current month index
      const periodStart = new Date(year, month, 1);
      const periodEnd = new Date(year, month + 1, 0, 23, 59, 59, 999);

      console.log(
        "Running monthly invoice generation for:",
        periodStart,
        periodEnd
      );
      const results = await generateInvoicesForPeriod(periodStart, periodEnd);
      console.log(
        "Monthly invoice results:",
        results.filter((r) => r.result || r.error).slice(0, 10)
      );
      // Consider logging results to DB or file for auditing
    } catch (err) {
      console.error("Monthly invoice cron error:", err);
    }
  // });
}

scheduleMonthlyInvoiceCron()

/* -------------------------------------------------------
   Helper: Build Query From req.query
----------------------------------------------------------*/
function buildInvoiceFilters(query) {
  const filters = {};

  // 1. Filter by invoiceNumber
  if (query.invoiceNumber) {
    filters.invoiceNumber = query.invoiceNumber.trim();
  }

  // 2. Filter by userId (admin only)
  if (query.userId) {
    filters.userId = query.userId;
  }

  // 3. Filter by exact date (invoice creation date)
  if (query.date) {
    const d = new Date(query.date);
    const start = new Date(d.setHours(0, 0, 0, 0));
    const end = new Date(d.setHours(23, 59, 59, 999));
    filters.createdAt = { $gte: start, $lte: end };
  }

  // 4. Filter by month + year
  if (query.month && query.year) {
    const year = Number(query.year);
    const month = Number(query.month) - 1; // 0-based
    const start = new Date(year, month, 1);
    const end = new Date(year, month + 1, 0, 23, 59, 59, 999);
    filters.createdAt = { $gte: start, $lte: end };
  }

  return filters;
}

/* -------------------------------------------------------
   Admin Controller — Fetch All Invoices
----------------------------------------------------------*/
const adminGetInvoices = async (req, res) => {
  try {
    // Check admin
    if (!req.user?.isAdmin) {
      return res.status(403).json({ success: false, message: "Unauthorized" });
    }

    const filters = buildInvoiceFilters(req.query);

    const invoices = await Invoice.find(filters).sort({ createdAt: -1 });

    const result = invoices.map((inv) => ({
      invoiceNumber: inv.invoiceNumber,
      totalShipments: inv.includedAwbs ? inv.includedAwbs.length : 0,
      invoiceDate: inv.createdAt.toISOString().split("T")[0],
      invoiceUrl: inv.s3Url || null,
      amount: inv.totalAmount,
      status: inv.status,
      userId: inv.userId, // admin sees this too
    }));

    return res.json({
      success: true,
      total: result.length,
      invoices: result,
    });
  } catch (err) {
    console.error("adminGetInvoices error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

/* -------------------------------------------------------
   User Controller — Get Only Logged-in User's Invoices
----------------------------------------------------------*/
const userGetInvoices = async (req, res) => {
  try {
    const userId = req.user._id;

    const filters = buildInvoiceFilters(req.query);
    filters.userId = userId; // Force user restriction

    const invoices = await Invoice.find(filters).sort({ createdAt: -1 });

    const result = invoices.map((inv) => ({
      invoiceNumber: inv.invoiceNumber,
      totalShipments: inv.includedAwbs ? inv.includedAwbs.length : 0,
      invoiceDate: inv.createdAt.toISOString().split("T")[0],
      invoiceUrl: inv.s3Url || null,
      amount: inv.totalAmount,
      status: inv.status,
    }));

    return res.json({
      success: true,
      total: result.length,
      invoices: result,
    });
  } catch (err) {
    console.error("userGetInvoices error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

/* -------------------------
   Exports (controllers)
   -------------------------*/
module.exports = {
  buildChargesFromWalletTransactions,
  generateInvoiceForUserMonth,
  generateInvoicesForPeriod,
  scheduleMonthlyInvoiceCron,
  adminGetInvoices,
  userGetInvoices,
};
