const express = require("express");
const PDFDocument = require("pdfkit");
const bwipjs = require("bwip-js");
const Order = require("../../../models/newOrder.model");
const https = require("https");

const router = express.Router();

/* ===============================
   HELPERS
================================ */
const fetchImageBuffer = (url) =>
  new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
      })
      .on("error", reject);
  });

/* ===============================
   CONTROLLER
================================ */
const generateLabel = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).send("Order not found");
    if (order.orderType !== "B2B")
      return res.status(400).send("Not a B2B order");

    const packages = order.B2BPackageDetails?.packages || [];
    if (!packages.length)
      return res.status(400).send("No B2B packages found");

    const doc = new PDFDocument({ size: "A4", margin: 20 });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=B2B-Label-${order.orderId}.pdf`
    );

    doc.pipe(res);

    /* ===============================
       BARCODE (MASTER AWB – SINGLE)
    ================================ */
    const awbBarcode = order.awb_number
      ? await bwipjs.toBuffer({
          bcid: "code128",
          text: String(order.awb_number),
          scale: 3,
          height: 10,
          includetext: false,
        })
      : null;

    /* ===============================
       LOGOS
    ================================ */
    // 🔹 Replace with real URLs
    const companyLogoUrl = "https://shipex-india.s3.ap-south-1.amazonaws.com/uploads/1767099868221_Shipex.jpg";
    const courierLogoUrl = "https://your-courier-logo-url.png";

    let companyLogo = null;
    let courierLogo = null;

    try {
      companyLogo = await fetchImageBuffer(companyLogoUrl);
      courierLogo = await fetchImageBuffer(courierLogoUrl);
    } catch (e) {
      console.warn("Logo load failed:", e.message);
    }

    /* ===============================
       LABEL GRID CONFIG
    ================================ */
    const LABEL_W = 270;
    const LABEL_H = 380;
    const GAP_X = 20;
    const GAP_Y = 20;

    let startX = 20;
    let startY = 20;
    let col = 0;

    packages.forEach((pkg, index) => {
      if (index > 0 && index % 4 === 0) {
        doc.addPage();
        startX = 20;
        startY = 20;
        col = 0;
      }

      const x = startX + col * (LABEL_W + GAP_X);
      const y = startY + Math.floor((index % 4) / 2) * (LABEL_H + GAP_Y);

      /* ===============================
         LABEL BORDER
      ================================ */
      doc.rect(x, y, LABEL_W, LABEL_H).stroke();

      /* ===============================
         LOGOS ROW
      ================================ */
      if (courierLogo)
        doc.image(courierLogo, x + 5, y + 5, { width: 80 });
      if (companyLogo)
        doc.image(companyLogo, x + LABEL_W - 85, y + 5, { width: 80 });

      /* ===============================
         BARCODE
      ================================ */
      if (awbBarcode) {
        doc.image(awbBarcode, x + 30, y + 50, { width: 210 });
        doc
          .font("Helvetica-Bold")
          .fontSize(10)
          .text(order.awb_number, x, y + 65, {
            width: LABEL_W,
            align: "center",
          });
      }

      /* ===============================
         BOX INFO
      ================================ */
      doc
        .font("Helvetica-Bold")
        .fontSize(10)
        .text(
          `Box : ${index + 1} / ${packages.length}`,
          x + 10,
          y + 95
        );

      /* ===============================
         CONSIGNEE
      ================================ */
      doc
        .font("Helvetica-Bold")
        .fontSize(9)
        .text("Shipping Address:", x + 10, y + 115);

      doc
        .font("Helvetica")
        .fontSize(9)
        .text(
          `${order.receiverAddress.contactName}
${order.receiverAddress.address}
${order.receiverAddress.city}, ${order.receiverAddress.state} - ${order.receiverAddress.pinCode}
Ph: ${order.receiverAddress.phoneNumber}`,
          x + 10,
          y + 130,
          { width: LABEL_W - 20 }
        );

      /* ===============================
         RETURN ADDRESS
      ================================ */
      doc
        .font("Helvetica-Bold")
        .text("Return Address:", x + 10, y + 215);

      doc
        .font("Helvetica")
        .text(
          `${order.pickupAddress.contactName}
${order.pickupAddress.address}
${order.pickupAddress.city}, ${order.pickupAddress.state} - ${order.pickupAddress.pinCode}`,
          x + 10,
          y + 230,
          { width: LABEL_W - 20 }
        );

      /* ===============================
         PACKAGE DETAILS
      ================================ */
      doc
        .font("Helvetica-Bold")
        .text("Box Details:", x + 10, y + 295);

      doc
        .font("Helvetica")
        .text(
          `L x W x H : ${pkg.length} x ${pkg.width} x ${pkg.height} cm
Weight     : ${pkg.weightPerBox} Kg`,
          x + 10,
          y + 310
        );

      col = col === 0 ? 1 : 0;
    });

    doc.end();
  } catch (err) {
    console.error("B2B label error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to generate B2B label" });
    }
  }
};

module.exports = { generateLabel };
