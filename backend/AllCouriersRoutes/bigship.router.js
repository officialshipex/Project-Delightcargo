const express = require("express");
const router = express.Router();

const { saveBigShip } = require("../AllCouriers/BigShip/Authorize/bigship.controller");
const {
  createCustomOrderBigShip,
  trackBigShipOrder,
  cancelBigShipOrder,
  getAllActiveCourierServicesBigShip,
} = require("../AllCouriers/BigShip/Courier/couriers.controller");
const Order = require("../models/newOrder.model");

// ── Auth / Courier Setup ──────────────────────────────────────────────────────
router.post("/getAuthToken", saveBigShip);

// ── Courier Services (Admin) ──────────────────────────────────────────────────
router.get("/getAllActiveCourierServices", getAllActiveCourierServicesBigShip);

// ── Shipment ──────────────────────────────────────────────────────────────────
router.post("/createShipment", createCustomOrderBigShip);

// ── Tracking ──────────────────────────────────────────────────────────────────
router.get("/track/:orderId", async (req, res) => {
  try {
    const order = await Order.findById(req.params.orderId);
    if (!order?.otherDetails?.bigshipOrderId) {
      return res.status(400).json({ success: false, message: "No BigShip order found for this order." });
    }
    const data = await trackBigShipOrder(order.otherDetails.bigshipOrderId);
    return res.status(data ? 200 : 400).json({ success: !!data, data });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Tracking failed", error: error.message });
  }
});

// ── Cancel ────────────────────────────────────────────────────────────────────
router.post("/cancel/:orderId", async (req, res) => {
  try {
    const order = await Order.findById(req.params.orderId);
    if (!order?.otherDetails?.bigshipOrderId) {
      return res.status(400).json({ success: false, message: "No BigShip order found for this order." });
    }
    const result = await cancelBigShipOrder(order.otherDetails.bigshipOrderId);
    if (result.error) return res.status(400).json({ success: false, message: result.error });
    return res.status(200).json({ success: true });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Cancellation failed", error: error.message });
  }
});

module.exports = router;
