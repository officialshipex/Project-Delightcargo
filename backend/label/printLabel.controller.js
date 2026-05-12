const express = require("express");
const PDFDocument = require("pdfkit");
const bwipjs = require("bwip-js");
const Order = require("../models/newOrder.model");
const LabelSettings = require("./labelCustomize.model");
const { Readable } = require("stream");

const router = express.Router();

router.get("/generate-pdf/:id", async (req, res) => {
  try {
    const orderData = await Order.findOne({ _id: req.params.id });
    const labelSettings = await LabelSettings.findOne({
      userId: orderData?.userId,
    });

    if (!orderData) {
      return res.status(404).send("Order not found");
    }

    // Barcodes
    const barcodeBuffer1 = await bwipjs.toBuffer({
      bcid: "code128",
      text: String(orderData.orderId),
      alttext: orderData.channelId
        ? `${orderData.orderId} / ${orderData.channelId}`
        : String(orderData.orderId),
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
    const formattedOrderDate1 = orderData.createdAt.toLocaleDateString(
      "en-US",
      options1
    );

    // ── Label size: A4 (default) or Thermal 4"×6" ──────────────────────────
    const isThermal = labelSettings?.labelSize === "thermal";
    const PAGE_W = isThermal ? 288 : 595;   // 4" or A4
    const PAGE_H = isThermal ? 432 : 842;   // 6" or A4
    const MARGIN  = isThermal ? 10  : 30;

    const doc = new PDFDocument({ size: [PAGE_W, PAGE_H], margin: MARGIN });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="shipping_label.pdf"`
    );

    // Draw border
    const pageWidth = doc.page.width;
    const pageHeight = doc.page.height;
    doc.rect(MARGIN - 10, MARGIN - 10, pageWidth - 2 * (MARGIN - 10), pageHeight - 2 * (MARGIN - 10)).stroke();

    // Responsive font sizes
    const FS_TITLE   = isThermal ? 9 : 16;
    const FS_BODY    = isThermal ? 7.5 : 14;
    const FS_SECTION = isThermal ? 8.5 : 18;
    const FS_SMALL   = isThermal ? 6.5 : 12;
    const FS_FOOT    = isThermal ? 6 : 10;
    const INNER_W    = pageWidth - 2 * MARGIN; // usable text width

    // Header: Receiver
    const headerWidth = INNER_W - (isThermal ? 60 : 110); // Leave room for logo
    doc.fontSize(FS_TITLE).font("Helvetica-Bold").text(`To:`, { align: "left" });
    doc
      .fontSize(FS_BODY)
      .font("Helvetica")
      .text(orderData.receiverAddress.contactName, { align: "left", width: headerWidth });
    doc.text(`${orderData.receiverAddress.address}`, {
      align: "left",
      width: headerWidth,
    });
    doc.text(
      `${orderData.receiverAddress.city}, ${orderData.receiverAddress.state}, ${orderData.receiverAddress.pinCode}`,
      { align: "left", width: headerWidth }
    );
    if (!labelSettings?.hideCustomerMobile || labelSettings == null) {
      doc.text(`MOBILE NO: ${orderData.receiverAddress.phoneNumber}`, {
        align: "left", width: headerWidth
      });
    }

    // Logo if allowed
    if (
      (labelSettings?.showLogoOnLabel && labelSettings?.logoUrl) ||
      labelSettings == null
    ) {
      const logoW   = isThermal ? 40 : 100;
      const imageX  = doc.page.width - MARGIN - logoW;
      const imageY  = MARGIN + 5;
      const imageWidth = logoW;

      const https = require("https");
      const getStreamBuffer = (url) =>
        new Promise((resolve, reject) => {
          https.get(url, (response) => {
            const chunks = [];
            response
              .on("data", (chunk) => chunks.push(chunk))
              .on("end", () => resolve(Buffer.concat(chunks)))
              .on("error", reject);
          });
        });

      try {
        const logoBuffer = await getStreamBuffer(labelSettings.logoUrl);
        doc.image(logoBuffer, imageX, imageY, { width: imageWidth });
      } catch (err) {
        console.error("Error loading logo image:", err.message);
      }
    }

    doc.moveDown(0.5);
    const line1Y = doc.y;
    doc.moveTo(MARGIN, line1Y).lineTo(pageWidth - MARGIN, line1Y).stroke();
    doc.y = line1Y + (isThermal ? 8 : 10);

    // Order Info
    const orderInfoYStart = doc.y;
    doc
      .fontSize(FS_BODY)
      .font("Helvetica-Bold")
      .text(`Order Date: `, { continued: true });
    doc.font("Helvetica").text(formattedOrderDate1);
    doc.font("Helvetica-Bold").text(`Invoice No: `, { continued: true });
    doc.font("Helvetica").text(orderData.orderId);
    if (!labelSettings?.warehouseSettings?.hideGstNumber) {
      doc.font("Helvetica-Bold").text(`GSTIN No: ${orderData.otherDetails?.gstin || ""}`);
    }

    // Order barcode
    let barcodeBottom = doc.y;
    if (!labelSettings?.hideOrderBarcode) {
      const bW = isThermal ? 80 : 120;
      const bH = isThermal ? 30 : 50;
      const bX = pageWidth - MARGIN - bW;
      const bY = isThermal ? orderInfoYStart : doc.y - 40;
      doc.image(barcodeBuffer1, bX, bY, { width: bW, height: bH });
      barcodeBottom = bY + bH;
    }

    doc.y = Math.max(doc.y, barcodeBottom) + (isThermal ? 5 : 10);
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

    // ======= Dynamic Table Section =======
    const columns = [];
    // Thermal: scale widths proportionally (288/595 ≈ 0.48)
    const S = isThermal ? 0.48 : 1;
    if (!labelSettings?.productDetails?.hideSKU || labelSettings == null)
      columns.push({ key: "sku", title: "SKU", width: Math.round(50 * S) });
    if (!labelSettings?.productDetails?.hideProduct || labelSettings == null)
      columns.push({ key: "name", title: "Item Name", width: Math.round(200 * S) });
    if (!labelSettings?.productDetails?.hideHSN || labelSettings == null)
      columns.push({ key: "hsn", title: "HSN", width: Math.round(65 * S) });
    if (!labelSettings?.productDetails?.hideQty || labelSettings == null)
      columns.push({ key: "quantity", title: isThermal ? "Qty" : "Qty.", width: Math.round(35 * S) });
    if (!labelSettings?.productDetails?.hideOrderAmount || labelSettings == null)
      columns.push({ key: "unitPrice", title: isThermal ? "Price" : "Unit Price", width: Math.round(80 * S) });
    if (!labelSettings?.productDetails?.hideTotalAmount || labelSettings == null)
      columns.push({ key: "totalAmount", title: isThermal ? "Total" : "Total Amount", width: Math.round(85 * S) });

    // Adjust last column to fill remaining width
    const tableLeft = MARGIN;
    const tableRight = pageWidth - MARGIN;

    if (columns.length > 0) {
      const totalFixedWidth = columns.slice(0, -1).reduce((sum, col) => sum + col.width, 0);
      columns[columns.length - 1].width = tableRight - tableLeft - totalFixedWidth;
    }

    const hasTable = columns.length > 0;

    if (hasTable && orderData.productDetails.length > 0) {
      const tableTop     = doc.y;
      const tLeft        = MARGIN;
      const headerHeight = isThermal ? 14 : 20;
      const tableWidth   = columns.reduce((sum, col) => sum + col.width, 0);

      let x = tLeft;
      columns.forEach((col) => {
        doc.font("Helvetica-Bold").fontSize(FS_SMALL)
          .text(col.title, x + 3, tableTop + 3, { width: col.width - 6 });
        x += col.width;
      });

      doc.moveTo(tLeft, tableTop).lineTo(tableRight, tableTop).stroke();
      doc.moveTo(tLeft, tableTop + headerHeight).lineTo(tableRight, tableTop + headerHeight).stroke();

      let currentY = tableTop + headerHeight;

      orderData.productDetails.forEach((product) => {
        const cellHeights = columns.map((col) => {
          const value = col.key === "totalAmount"
            ? (product.quantity * product.unitPrice).toString()
            : (product[col.key]?.toString() || "");
          return doc.heightOfString(value, { width: col.width - 6, align: "left" });
        });
        const rowHeight = Math.max(...cellHeights) + 5;

        x = tLeft;
        columns.forEach((col) => {
          const value = col.key === "totalAmount"
            ? (product.quantity * product.unitPrice).toString()
            : (product[col.key]?.toString() || "");
          doc.font("Helvetica").fontSize(FS_SMALL - (isThermal ? 1 : 0))
            .text(value, x + 3, currentY + 3, { width: col.width - 6, align: "left" });
          x += col.width;
        });

        doc.moveTo(tLeft, currentY + rowHeight).lineTo(tableRight, currentY + rowHeight).stroke();
        currentY += rowHeight;
      });

      let vx = tLeft;
      columns.forEach((col) => {
        doc.moveTo(vx, tableTop).lineTo(vx, currentY).stroke();
        vx += col.width;
      });
      doc.moveTo(tableRight, tableTop).lineTo(tableRight, currentY).stroke();

      // IMPORTANT: Update doc.y to the end of the table to prevent address overlap
      doc.y = currentY + (isThermal ? 10 : 20);
    } else {
      // If no table, add a small gap
      doc.moveDown(2);
    }

    // ======= END Table Section =======

    // Pickup Address
    // Before rendering Pickup Address:
    const showPickupAddressSection =
      !labelSettings?.warehouseSettings?.hidePickupName ||
      !labelSettings?.warehouseSettings?.hidePickupAddress ||
      !labelSettings?.warehouseSettings?.hidePickupMobile ||
      labelSettings == null;

    const showReturnAddressSection =
      !labelSettings?.warehouseSettings?.hideRTOName ||
      !labelSettings?.warehouseSettings?.hideRTOAddress ||
      !labelSettings?.warehouseSettings?.hideRTOMobile ||
      labelSettings == null;

    const leftMargin = MARGIN;

    if (showPickupAddressSection) {
      doc.moveDown();
      doc.font("Helvetica-Bold").text(`Pickup Address:`, leftMargin, doc.y);
      if (
        !labelSettings?.warehouseSettings?.hidePickupName ||
        labelSettings == null
      )
        doc
          .font("Helvetica")
          .text(`${orderData.pickupAddress.contactName}`, leftMargin, doc.y);
      if (
        !labelSettings?.warehouseSettings?.hidePickupAddress ||
        labelSettings == null
      ) {
        doc.text(`${orderData.pickupAddress.address}`, leftMargin, doc.y);
        doc.text(
          `${orderData.pickupAddress.city}, ${orderData.pickupAddress.state}, ${orderData.pickupAddress.pinCode}`,
          leftMargin,
          doc.y
        );
      }
      if (
        !labelSettings?.warehouseSettings?.hidePickupMobile ||
        labelSettings == null
      )
        doc.text(
          `Mobile No: ${orderData.pickupAddress.phoneNumber}`,
          leftMargin,
          doc.y
        );
    } else {
      doc.moveDown(4); // maintain vertical space equivalent to Pickup Address section
    }

    if (showReturnAddressSection) {
      doc.moveDown();
      doc.font("Helvetica-Bold").text(`Return Address:`, leftMargin, doc.y);
      if (
        !labelSettings?.warehouseSettings?.hideRTOName ||
        labelSettings == null
      )
        doc
          .font("Helvetica")
          .text(orderData.pickupAddress.contactName, leftMargin, doc.y);
      if (
        !labelSettings?.warehouseSettings?.hideRTOAddress ||
        labelSettings == null
      ) {
        doc.text(`${orderData.pickupAddress.address}`, leftMargin, doc.y);
        doc.text(
          `${orderData.pickupAddress.city}, ${orderData.pickupAddress.state}, ${orderData.pickupAddress.pinCode}`,
          leftMargin,
          doc.y
        );
      }
      if (
        !labelSettings?.warehouseSettings?.hideRTOMobile ||
        labelSettings == null
      )
        doc.text(
          `Mobile No: ${orderData.pickupAddress.phoneNumber}`,
          leftMargin,
          doc.y
        );
    } else {
      doc.moveDown(4); // maintain vertical space equivalent to Return Address section
    }

    // After these sections or their placeholders
    doc.moveDown(isThermal ? 1 : 2);
    doc.moveTo(MARGIN, doc.y).lineTo(pageWidth - MARGIN, doc.y).stroke();
    doc.moveDown(1);

    doc.x = leftMargin;

    doc
      .font("Helvetica")
      .fontSize(FS_FOOT)
      .text(
        "This is a computer-generated document, hence does not require a signature.",
        { align: "left", width: INNER_W }
      );
    if (!isThermal) {
      doc
        .text(
          "Note: All disputes are subject to Delhi jurisdiction. Goods once sold will only be taken back or exchanged as per",
          { align: "left", width: INNER_W }
        )
        .text("the store's exchange/return policy.", {
          align: "left",
          width: INNER_W,
        });
    }

    doc.pipe(res);
    doc.end();
  } catch (error) {
    console.error("Error generating PDF:", error);
    res.status(500).json({ error: "Error generating PDF" });
  }
});

router.get("/proxy-label", async (req, res) => {
  try {
    const fileUrl = req.query.url;
    if (!fileUrl) return res.status(400).json({ error: "URL is required" });

    const response = await fetch(fileUrl);
    if (!response.ok) throw new Error("Failed to fetch label from S3");

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Access-Control-Allow-Origin", "*");

    // ✅ Fix: Convert Web Stream to Node Stream
    const nodeStream = Readable.fromWeb(response.body);
    nodeStream.pipe(res);
  } catch (error) {
    console.error("Error proxying label:", error);
    res.status(500).json({ error: "Proxy failed" });
  }
});

module.exports = router;
