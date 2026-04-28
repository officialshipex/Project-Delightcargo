const express = require("express");
const router = express.Router();
const CourierService = require("../models/CourierService.Schema");

// ✅ Get All Courier Services
router.get("/couriers", async (req, res) => {
  try {
    const couriers = await CourierService.find();
    res.status(200).json(couriers);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ✅ Create New Courier Service
router.post("/couriers", async (req, res) => {
  try {
    const { provider, courier, courierType, name, status, courier_id } = req.body;

    const newCourier = new CourierService({
      provider,
      courier,
      courierType,
      name,
      status,
      courier_id,
    });
    console.log(req.body);
    await newCourier.save();
    res.status(201).json(newCourier);
  } catch (error) {
    console.log(error);
    res.status(400).json({ error: error.message });
  }
});

router.put("/updateStatus/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!status || !["Enable", "Disable"].includes(status)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid status value" });
    }

    const updatedCourier = await CourierService.findByIdAndUpdate(
      id,
      { status },
      { new: true }
    );

    if (!updatedCourier) {
      return res
        .status(404)
        .json({ success: false, message: "Courier not found" });
    }

    res
      .status(200)
      .json({ success: true, message: "Status updated", data: updatedCourier });
  } catch (error) {
    console.error("Error updating courier status:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ✅ Update Courier Service
router.put("/couriers/:id", async (req, res) => {
  try {
    console.log(req.params.id);
    const updatedCourier = await CourierService.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true }
    );

    if (!updatedCourier) {
      return res.status(404).json({ message: "Courier not found" });
    }

    res.status(200).json(updatedCourier);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ✅ Delete Courier Service
router.delete("/couriers/:id", async (req, res) => {
  try {
    const deletedCourier = await CourierService.findByIdAndDelete(
      req.params.id
    );
    if (!deletedCourier) {
      return res.status(404).json({ message: "Courier not found" });
    }
    res.status(200).json({ message: "Courier deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
