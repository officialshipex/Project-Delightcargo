const express = require("express");
const PDFDocument = require("pdfkit");
const bwipjs = require("bwip-js");
const streamBuffers = require("stream-buffers");
const Order = require("../../models/newOrder.model");
const LabelSettings = require("../../label/labelCustomize.model");
const { s3 } = require("../../config/s3");
const { PutObjectCommand } = require("@aws-sdk/client-s3");

const generateLabel = async (req, res) => {
  try {
    const orderData = await Order.findOne({ awb_number: req.params.awb });
    if (!orderData) {
      return res.status(404).json({ error: "Order not found" });
    }
    if (orderData.userId.toString() !== req.user._id.toString()) {
      return res.status(404).json({ error: "Order not found" });
    }
    if (orderData.label) {
      return res.json({
        success: true,
        message: "Label already exists",
        label: orderData.label,
      });
    }

    const labelSettings = await LabelSettings.findOne({
      userId: orderData?.userId,
    });

    const writableStreamBuffer = new streamBuffers.WritableStreamBuffer({
      initialSize: 100 * 1024,
      incrementAmount: 10 * 1024,
    });

    // ── Layout Config ──────────────────────────────────────────────────────
    const isThermal = labelSettings?.labelSize === "thermal";
    const PAGE_W = isThermal ? 288 : 595;   // 4" or A4
    const PAGE_H = isThermal ? 432 : 842;   // 6" or A4
    const MARGIN  = isThermal ? 10  : 30;

    const doc = new PDFDocument({ size: [PAGE_W, PAGE_H], margin: MARGIN });
    doc.pipe(writableStreamBuffer);

    // Barcodes
    const barcodeBuffer1 = await bwipjs.toBuffer({
      bcid: "code128",
      text: String(orderData.orderId),
      scale: 3,
      height: 10,
      includetext: true,
      textyoffset: 5,
      textxalign: "center",
    });

    const barcodeBuffer2 = await bwipjs.toBuffer({
      bcid: "code128",
      text: String(orderData.awb_number),
      scale: 6,
      height: 40,
      includetext: false,
    });

    const options1 = { year: "numeric", month: "short", day: "numeric" };
    const formattedOrderDate1 = orderData.createdAt.toLocaleDateString("en-US", options1);

    // Draw border
    const pageWidth = doc.page.width;
    const pageHeight = doc.page.height;
    doc.rect(MARGIN - 5, MARGIN - 5, pageWidth - 2 * (MARGIN - 5), pageHeight - 2 * (MARGIN - 5)).stroke();

    // Responsive font sizes
    const FS_TITLE   = isThermal ? 9 : 16;
    const FS_BODY    = isThermal ? 7.5 : 14;
    const FS_SECTION = isThermal ? 8.5 : 18;
    const FS_SMALL   = isThermal ? 6.5 : 12;
    const FS_FOOT    = isThermal ? 6 : 10;
    const INNER_W    = pageWidth - 2 * MARGIN;

    // Header: Receiver
    const headerWidth = INNER_W - (isThermal ? 60 : 110); // Leave room for logo
    doc.fontSize(FS_TITLE).font("Helvetica-Bold").text(`To:`, { align: "left" });
    doc.fontSize(FS_BODY).font("Helvetica").text(orderData.receiverAddress.contactName, { align: "left", width: headerWidth });
    doc.text(`${orderData.receiverAddress.address}`, { align: "left", width: headerWidth });
    doc.text(`${orderData.receiverAddress.city}, ${orderData.receiverAddress.state}, ${orderData.receiverAddress.pinCode}`, { align: "left", width: headerWidth });
    if (!labelSettings?.hideCustomerMobile || labelSettings == null) {
      doc.text(`MOBILE NO: ${orderData.receiverAddress.phoneNumber}`, { align: "left", width: headerWidth });
    }

    // Logo
    if ((labelSettings?.showLogoOnLabel && labelSettings?.logoUrl) || labelSettings == null) {
      const logoW   = isThermal ? 40 : 100;
      const imageX  = doc.page.width - MARGIN - logoW;
      const imageY  = MARGIN + 5;
      const https = require("https");
      const getStreamBuffer = (url) => new Promise((resolve, reject) => {
        https.get(url, (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk)).on("end", () => resolve(Buffer.concat(chunks))).on("error", reject);
        });
      });
      try {
        const logoBuffer = await getStreamBuffer(labelSettings.logoUrl);
        doc.image(logoBuffer, imageX, imageY, { width: logoW });
      } catch (err) { console.error("Logo error:", err.message); }
    }

    doc.moveDown(0.5);
    const line1Y = doc.y;
    doc.moveTo(MARGIN, line1Y).lineTo(pageWidth - MARGIN, line1Y).stroke();
    doc.y = line1Y + (isThermal ? 8 : 10);

    // Order Info
    const orderInfoYStart = doc.y;
    doc.fontSize(FS_BODY).font("Helvetica-Bold").text(`Order Date: `, { continued: true });
    doc.font("Helvetica").text(formattedOrderDate1);
    doc.font("Helvetica-Bold").text(`Invoice No: `, { continued: true });
    doc.font("Helvetica").text(orderData.orderId);
    if (!labelSettings?.warehouseSettings?.hideGstNumber) {
      doc.font("Helvetica-Bold").text(`GSTIN No: `, { continued: true });
      doc.font("Helvetica").text(orderData.otherDetails?.gstin || "");
    }

    // Order barcode
    if (!labelSettings?.hideOrderBarcode) {
      const bW = isThermal ? 80 : 120;
      const bH = isThermal ? 30 : 50;
      const bX = pageWidth - MARGIN - bW;
      const bY = isThermal ? orderInfoYStart : doc.y - 40;
      doc.image(barcodeBuffer1, bX, bY, { width: bW, height: bH });
    }

    doc.moveDown(isThermal ? 1.5 : 0.5);
    const line2Y = doc.y;
    doc.moveTo(MARGIN, line2Y).lineTo(pageWidth - MARGIN, line2Y).stroke();
    doc.y = line2Y + (isThermal ? 10 : 15);

    // ── Payment / Info (Left) + AWB barcode (Right) ───────────────────────
    const paymentText = orderData.paymentDetails.method === "COD" ? "COD" : "PREPAID";
    const infoYStart = doc.y;
    const leftW = INNER_W * (isThermal ? 0.55 : 0.6);
    const rightW = INNER_W - leftW - 10;
    const rightX = MARGIN + leftW + 10;

    // Left Side: Payment & Weight
    doc.fontSize(FS_SECTION).font("Helvetica-Bold").text("MODE: ", MARGIN, infoYStart, { continued: true, width: leftW }).font("Helvetica").text(paymentText);
    if (!labelSettings?.productDetails?.hideOrderAmount || labelSettings == null) {
      doc.fontSize(FS_SECTION).font("Helvetica-Bold").text("AMOUNT: ", MARGIN, doc.y, { continued: true, width: leftW }).font("Helvetica").text(`${orderData.paymentDetails.amount}`);
    }
    doc.moveDown(0.5);
    doc.fontSize(FS_SMALL).text(`WEIGHT: ${orderData.packageDetails.applicableWeight}`, { align: "left", width: leftW });
    doc.text(`Dimensions (cm): ${orderData.packageDetails.volumetricWeight.length}*${orderData.packageDetails.volumetricWeight.width}*${orderData.packageDetails.volumetricWeight.height}`, { align: "left", width: leftW });
    const infoYEnd = doc.y;

    // Right Side: Courier & Barcode
    const barcodeH = isThermal ? 35 : 50;
    const courierServiceText = orderData.courierServiceName || "N/A";
    
    // Courier Name
    doc.font("Helvetica-Bold").fontSize(FS_SMALL);
    const courierTextW = doc.widthOfString(courierServiceText);
    doc.text(courierServiceText, rightX + (rightW - courierTextW) / 2, infoYStart);
    
    // Barcode
    const barcodeY = doc.y + 2;
    doc.image(barcodeBuffer2, rightX, barcodeY, { width: rightW, height: barcodeH });
    
    // AWB Number
    doc.font("Helvetica-Bold").fontSize(FS_SMALL);
    const awbText = orderData.awb_number;
    const awbTextW = doc.widthOfString(awbText);
    doc.text(awbText, rightX + (rightW - awbTextW) / 2, barcodeY + barcodeH + 2);
    const barcodeYEnd = doc.y;

    // Sync doc.y to the lower of the two blocks
    doc.y = Math.max(infoYEnd, barcodeYEnd) + (isThermal ? 5 : 15);
    doc.moveDown(isThermal ? 1 : 2);

    // ======= Table Section =======
    const columns = [];
    const S = isThermal ? 0.48 : 1;
    if (!labelSettings?.productDetails?.hideSKU || labelSettings == null) columns.push({ key: "sku", title: "SKU", width: Math.round(50 * S) });
    if (!labelSettings?.productDetails?.hideProduct || labelSettings == null) columns.push({ key: "name", title: "Item Name", width: Math.round(200 * S) });
    if (!labelSettings?.productDetails?.hideHSN || labelSettings == null) columns.push({ key: "hsn", title: "HSN", width: Math.round(65 * S) });
    if (!labelSettings?.productDetails?.hideQty || labelSettings == null) columns.push({ key: "quantity", title: isThermal ? "Qty" : "Qty.", width: Math.round(35 * S) });
    if (!labelSettings?.productDetails?.hideOrderAmount || labelSettings == null) columns.push({ key: "unitPrice", title: isThermal ? "Price" : "Unit Price", width: Math.round(80 * S) });
    if (!labelSettings?.productDetails?.hideTotalAmount || labelSettings == null) columns.push({ key: "totalAmount", title: isThermal ? "Total" : "Total Amount", width: Math.round(85 * S) });

    const tableLeft = MARGIN;
    const tableRight = pageWidth - MARGIN;
    if (columns.length > 0) {
      const totalFW = columns.slice(0, -1).reduce((sum, col) => sum + col.width, 0);
      columns[columns.length - 1].width = tableRight - tableLeft - totalFW;
      const tableTop = doc.y;
      const headerH = isThermal ? 14 : 20;
      let x = tableLeft;
      columns.forEach(col => {
        doc.font("Helvetica-Bold").fontSize(FS_SMALL).text(col.title, x + 3, tableTop + 3, { width: col.width - 6 });
        x += col.width;
      });
      doc.moveTo(tableLeft, tableTop).lineTo(tableRight, tableTop).stroke();
      doc.moveTo(tableLeft, tableTop + headerH).lineTo(tableRight, tableTop + headerH).stroke();
      let curY = tableTop + headerH;
      orderData.productDetails.forEach(p => {
        const heights = columns.map(col => doc.heightOfString(col.key === "totalAmount" ? (p.quantity * p.unitPrice).toString() : (p[col.key]?.toString() || ""), { width: col.width - 6 }));
        const rowH = Math.max(...heights) + 5;
        x = tableLeft;
        columns.forEach(col => {
          doc.font("Helvetica").fontSize(FS_SMALL - (isThermal ? 1 : 0)).text(col.key === "totalAmount" ? (p.quantity * p.unitPrice).toString() : (p[col.key]?.toString() || ""), x + 3, curY + 3, { width: col.width - 6 });
          x += col.width;
        });
        doc.moveTo(tableLeft, curY + rowH).lineTo(tableRight, curY + rowH).stroke();
        curY += rowH;
      });
      let vx = tableLeft;
      columns.forEach(col => { doc.moveTo(vx, tableTop).lineTo(vx, curY).stroke(); vx += col.width; });
      doc.moveTo(tableRight, tableTop).lineTo(tableRight, curY).stroke();
      doc.y = curY + (isThermal ? 10 : 20);
    } else { doc.moveDown(2); }

    // Addresses
    const showPickup = !labelSettings?.warehouseSettings?.hidePickupName || !labelSettings?.warehouseSettings?.hidePickupAddress || !labelSettings?.warehouseSettings?.hidePickupMobile || labelSettings == null;
    const showReturn = !labelSettings?.warehouseSettings?.hideRTOName || !labelSettings?.warehouseSettings?.hideRTOAddress || !labelSettings?.warehouseSettings?.hideRTOMobile || labelSettings == null;
    if (showPickup) {
      doc.moveDown();
      doc.font("Helvetica-Bold").text("Pickup Address:", MARGIN, doc.y);
      if (!labelSettings?.warehouseSettings?.hidePickupName) doc.font("Helvetica").text(orderData.pickupAddress.contactName, MARGIN, doc.y);
      if (!labelSettings?.warehouseSettings?.hidePickupAddress) {
        doc.text(orderData.pickupAddress.address, MARGIN, doc.y);
        doc.text(`${orderData.pickupAddress.city}, ${orderData.pickupAddress.state}, ${orderData.pickupAddress.pinCode}`, MARGIN, doc.y);
      }
      if (!labelSettings?.warehouseSettings?.hidePickupMobile) doc.text(`Mobile: ${orderData.pickupAddress.phoneNumber}`, MARGIN, doc.y);
    }
    if (showReturn) {
      doc.moveDown();
      doc.font("Helvetica-Bold").text("Return Address:", MARGIN, doc.y);
      if (!labelSettings?.warehouseSettings?.hideRTOName) doc.font("Helvetica").text(orderData.pickupAddress.contactName, MARGIN, doc.y);
      if (!labelSettings?.warehouseSettings?.hideRTOAddress) {
        doc.text(orderData.pickupAddress.address, MARGIN, doc.y);
        doc.text(`${orderData.pickupAddress.city}, ${orderData.pickupAddress.state}, ${orderData.pickupAddress.pinCode}`, MARGIN, doc.y);
      }
      if (!labelSettings?.warehouseSettings?.hideRTOMobile) doc.text(`Mobile: ${orderData.pickupAddress.phoneNumber}`, MARGIN, doc.y);
    }

    doc.moveDown(isThermal ? 1 : 2);
    doc.moveTo(MARGIN, doc.y).lineTo(pageWidth - MARGIN, doc.y).stroke();
    doc.moveDown(1);
    doc.font("Helvetica").fontSize(FS_FOOT).text("This is a computer-generated document, hence does not require a signature.", { align: "left", width: INNER_W });
    if (!isThermal) {
      doc.text("Note: All disputes are subject to Delhi jurisdiction. Goods once sold will only be taken back or exchanged as per the store's policy.", { align: "left", width: INNER_W });
    }

    doc.end();

    doc.on("end", async () => {
      try {
        const pdfBuffer = writableStreamBuffer.getContents();
        const labelKey = `labels/${Date.now()}_${orderData.orderId || "label"}.pdf`;
        const labelUrl = `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${labelKey}`;
        const uploadParams = { Bucket: process.env.AWS_BUCKET_NAME, Key: labelKey, Body: pdfBuffer, ContentType: "application/pdf" };
        await s3.send(new PutObjectCommand(uploadParams));
        orderData.label = labelUrl;
        await orderData.save();
        return res.json({ success: true, message: "Label generated successfully", label: labelUrl });
      } catch (err) {
        console.error("S3 error:", err);
        return res.status(500).json({ error: "S3 upload failed" });
      }
    });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ error: "Error generating label" });
  }
};

module.exports = generateLabel;
