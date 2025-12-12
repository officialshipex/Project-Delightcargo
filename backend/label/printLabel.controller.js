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

    const doc = new PDFDocument({ size: "A4", margin: 30 });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="shipping_label.pdf"`
    );

    // Draw border
    const pageWidth = doc.page.width;
    const pageHeight = doc.page.height;
    doc.rect(20, 20, pageWidth - 40, pageHeight - 40).stroke();

    // Header: Receiver
    doc.fontSize(16).font("Helvetica-Bold").text(`To:`, { align: "left" });
    doc
      .fontSize(14)
      .font("Helvetica")
      .text(orderData.receiverAddress.contactName, { align: "left" });
    doc.text(`${orderData.receiverAddress.address}`, {
      align: "left",
      width: 300,
    });
    doc.text(
      `${orderData.receiverAddress.city}, ${orderData.receiverAddress.state}, ${orderData.receiverAddress.pinCode}`,
      { align: "left" }
    );
    if (!labelSettings?.hideCustomerMobile || labelSettings == null) {
      doc.text(`MOBILE NO: ${orderData.receiverAddress.phoneNumber}`, {
        align: "left",
      });
    }

    // Logo if allowed
    if (
      (labelSettings?.showLogoOnLabel && labelSettings?.logoUrl) ||
      labelSettings == null
    ) {
      const imageX = doc.page.width - 200;
      const imageY = 50;
      const imageWidth = 100;

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

    doc.moveDown();
    doc.rect(20, doc.y - 10, 555, 1).stroke();
    doc.moveDown();

    // Order Info
    doc
      .fontSize(14)
      .font("Helvetica-Bold")
      .text(`Order Date: `, { continued: true });
    doc.font("Helvetica").text(formattedOrderDate1);
    doc.font("Helvetica-Bold").text(`Invoice No: `, { continued: true });
    doc.font("Helvetica").text(orderData.orderId);
    if (!labelSettings?.warehouseSettings.hideGstNumber) {
      doc.font("Helvetica-Bold").text(`GSTIN No: `, { continued: true });
      doc.font("Helvetica").text(orderData.otherDetails.gstin);
    }

    // Order barcode
    const barcodeX = 380;
    const barcodeY = doc.y - 40;
    if (!labelSettings?.hideOrderBarcode) {
      doc.image(barcodeBuffer1, barcodeX, barcodeY, { width: 120, height: 50 });
    }

    doc.moveDown(2);
    doc.rect(20, doc.y - 10, 555, 1).stroke();
    doc.moveDown(2);

    // Payment and Amount
    const paymentText =
      orderData.paymentDetails.method === "COD" ? "COD" : "PREPAID";

    doc
      .fontSize(18)
      .font("Helvetica-Bold")
      .text("MODE: ", 30, doc.y, { continued: true })
      .font("Helvetica")
      .text(paymentText);

    if (
      !labelSettings?.productDetails.hideOrderAmount ||
      labelSettings == null
    ) {
      doc
        .fontSize(18)
        .font("Helvetica-Bold")
        .text("AMOUNT: ", 30, doc.y, { continued: true })
        .font("Helvetica")
        .text(`${orderData.paymentDetails.amount}`);
      doc.moveDown();
    }

    // Weight & Dimensions
    doc
      .fontSize(12)
      .text(`WEIGHT: ${orderData.packageDetails.applicableWeight}`, {
        align: "left",
      });
    doc.text(
      `Dimensions (cm): ${orderData.packageDetails.volumetricWeight.length}*${orderData.packageDetails.volumetricWeight.width}*${orderData.packageDetails.volumetricWeight.height}`,
      { align: "left" }
    );

    // ----------- Set a fixed y for the right-side barcode section:
    const rightBlockY = 280; // Adjust this to match your preferred layout

    const barcodeX1 = 320; // right side (you can tweak X too)
    const courierServiceText = orderData.courierServiceName || "N/A";
    const textWidth = doc.widthOfString(courierServiceText);
    const textX = barcodeX1 + (200 - textWidth) / 2;

    doc
      .font("Helvetica-Bold")
      .text(courierServiceText, textX, rightBlockY - 20);
    doc.image(barcodeBuffer2, barcodeX1, rightBlockY, {
      width: 200,
      height: 50,
    });

    const textWidth1 = doc.widthOfString(orderData.awb_number);
    const textX1 = barcodeX1 + (200 - textWidth1) / 2;
    doc
      .font("Helvetica-Bold")
      .fontSize(12)
      .text(orderData.awb_number, textX1, rightBlockY + 55);

    // ----------- Restore doc.y for remaining content:
    doc.y = Math.max(doc.y, rightBlockY + 75);

    // Now the rest of your content can resume below this section as usual

    doc.moveDown(2);

    // ======= Dynamic Table Section =======
    // Dynamically build columns and headers
    const columns = [];
    if (!labelSettings?.productDetails.hideSKU || labelSettings == null)
      columns.push({ key: "sku", title: "SKU", width: 65 });
    if (!labelSettings?.productDetails.hideProduct || labelSettings == null)
      columns.push({ key: "name", title: "Item Name", width: 220 });
    if (!labelSettings?.productDetails.hideHSN || labelSettings == null)
      columns.push({ key: "hsn", title: "HSN", width: 65 });
    if (!labelSettings?.productDetails.hideQty || labelSettings == null)
      columns.push({ key: "quantity", title: "Qty.", width: 35 });
    if (!labelSettings?.productDetails.hideOrderAmount || labelSettings == null)
      columns.push({ key: "unitPrice", title: "Unit Price", width: 80 });
    if (!labelSettings?.productDetails.hideTotalAmount || labelSettings == null)
      columns.push({ key: "totalAmount", title: "Total Amount", width: 85 });

    // Adjust last column width so table fills full width to right margin
    const tableLeft = 20;
    const tableRight = 575;

    if (columns.length > 0) {
      const totalFixedWidth = columns
        .slice(0, -1)
        .reduce((sum, col) => sum + col.width, 0);
      columns[columns.length - 1].width =
        tableRight - tableLeft - totalFixedWidth;
    }

    const hasTable = columns.length > 0;

    if (hasTable && orderData.productDetails.length > 0) {
      const tableTop = doc.y;
      const tableLeft = 20;
      const headerHeight = 20;

      const tableWidth = columns.reduce((sum, col) => sum + col.width, 0);

      // ===== HEADER =====
      let x = tableLeft;
      columns.forEach((col) => {
        doc
          .font("Helvetica-Bold")
          .fontSize(12)
          .text(col.title, x + 5, tableTop + 5, { width: col.width - 10 });
        x += col.width;
      });

      // Draw header borders
      doc
        .moveTo(tableLeft, tableTop)
        .lineTo(tableLeft + tableWidth, tableTop)
        .stroke();

      doc
        .moveTo(tableLeft, tableTop + headerHeight)
        .lineTo(tableLeft + tableWidth, tableTop + headerHeight)
        .stroke();

      // ===== ROWS WITH DYNAMIC HEIGHTS =====

      let currentY = tableTop + headerHeight;

      orderData.productDetails.forEach((product, rowIndex) => {
        // 1️⃣ Calculate wrapped text heights for each cell
        const cellHeights = columns.map((col) => {
          let value;

          if (col.key === "totalAmount") {
            value = (product.quantity * product.unitPrice).toString();
          } else {
            value = product[col.key]?.toString() || "";
          }

          return doc.heightOfString(value, {
            width: col.width - 10,
            align: "left",
          });
        });

        // 2️⃣ Row height = tallest cell height + padding
        const rowHeight = Math.max(...cellHeights) + 10;

        // 3️⃣ Draw row text
        x = tableLeft;
        columns.forEach((col, index) => {
          let value;

          if (col.key === "totalAmount") {
            value = (product.quantity * product.unitPrice).toString();
          } else {
            value = product[col.key]?.toString() || "";
          }

          doc
            .font("Helvetica")
            .fontSize(12)
            .text(value, x + 5, currentY + 5, {
              width: col.width - 10,
              align: "left",
            });

          x += col.width;
        });

        // 4️⃣ Draw row borders
        doc
          .moveTo(tableLeft, currentY)
          .lineTo(tableLeft + tableWidth, currentY)
          .stroke();

        doc
          .moveTo(tableLeft, currentY + rowHeight)
          .lineTo(tableLeft + tableWidth, currentY + rowHeight)
          .stroke();

        currentY += rowHeight; // Move to next row start
      });

      // ===== FINAL RIGHT & VERTICAL BORDERS =====
      let vx = tableLeft;
      columns.forEach((col) => {
        doc.moveTo(vx, tableTop).lineTo(vx, currentY).stroke();
        vx += col.width;
      });

      // Final right border
      doc.moveTo(vx, tableTop).lineTo(vx, currentY).stroke();

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

    const leftMargin = 30;

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
    doc.moveDown(2);
    doc.moveTo(20, doc.y).lineTo(575, doc.y).stroke();
    doc.moveDown(1);

    doc.x = leftMargin;
    doc.y = doc.y; // keep current vertical position

    doc
      .font("Helvetica")
      .fontSize(10)
      .text(
        "This is a computer-generated document, hence does not require a signature.",
        { align: "left", width: 500 }
      );
    doc
      .text(
        "Note: All disputes are subject to Delhi jurisdiction. Goods once sold will only be taken back or exchanged as per",
        { align: "left", width: 500 }
      )
      .text("the store’s exchange/return policy.", {
        align: "left",
        width: 500,
      });

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
