const express = require("express");
const router = express.Router();
const CourierService = require("../models/CourierService.Schema");
const Plan = require("../models/Plan.model");
const RateCard = require("../models/rateCards");
const mongoose = require("mongoose");

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
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { id } = req.params;
    const updateData = req.body;

    const oldService = await CourierService.findById(id).session(session);
    if (!oldService) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ message: "Courier not found" });
    }

    const providerChanged = updateData.provider && updateData.provider !== oldService.provider;

    const updatedCourier = await CourierService.findByIdAndUpdate(
      id,
      updateData,
      { new: true, session }
    );

    if (providerChanged) {
      const serviceName = updatedCourier.name;
      const targetProvider = updateData.provider;

      // Update global RateCard collection
      await RateCard.updateMany(
        { courierServiceName: serviceName },
        { $set: { courierProviderName: targetProvider } },
        { session }
      );

      // Update all Plans
      const affectedPlans = await Plan.find({ "rateCard.courierServiceName": serviceName }).session(session);
      for (const plan of affectedPlans) {
        let modified = false;
        if (Array.isArray(plan.rateCard)) {
          plan.rateCard.forEach(rc => {
            if (rc.courierServiceName === serviceName) {
              rc.courierProviderName = targetProvider;
              modified = true;
            }
          });
        }
        if (modified) {
          plan.markModified("rateCard");
          await plan.save({ session });
        }
      }
    }

    await session.commitTransaction();
    session.endSession();
    res.status(200).json(updatedCourier);
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.error("Update Courier Error:", error);
    res.status(400).json({ error: error.message });
  }
});

// ✅ Bulk Change Provider
router.post("/changeProvider", async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { serviceIds, targetProvider } = req.body;

    if (!serviceIds || !Array.isArray(serviceIds) || serviceIds.length === 0) {
      return res.status(400).json({ success: false, message: "No services selected" });
    }

    if (!targetProvider) {
      return res.status(400).json({ success: false, message: "Target provider is required" });
    }

    // 1. Fetch services to get names and check current providers
    const services = await CourierService.find({ _id: { $in: serviceIds } }).session(session);
    if (services.length === 0) {
      return res.status(404).json({ success: false, message: "Selected services not found" });
    }

    const firstProvider = services[0].provider;
    const allSame = services.every(s => s.provider === firstProvider);
    if (!allSame) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ success: false, message: "All selected services must have the same provider" });
    }

    const serviceNames = services.map(s => s.name);

    // 2. Update CourierService collection
    await CourierService.updateMany(
      { _id: { $in: serviceIds } },
      { $set: { provider: targetProvider } },
      { session }
    );

    // 3. Update global RateCard collection
    await RateCard.updateMany(
      { courierServiceName: { $in: serviceNames } },
      { $set: { courierProviderName: targetProvider } },
      { session }
    );

    // 4. Update all Plans (including user-specific rates)
    // Since Plan.rateCard is Mixed, we must update documents individually or use a complex update
    const affectedPlans = await Plan.find({ "rateCard.courierServiceName": { $in: serviceNames } }).session(session);

    for (const plan of affectedPlans) {
      let modified = false;
      if (Array.isArray(plan.rateCard)) {
        plan.rateCard.forEach(rc => {
          if (serviceNames.includes(rc.courierServiceName)) {
            rc.courierProviderName = targetProvider;
            modified = true;
          }
        });
      }

      if (modified) {
        plan.markModified("rateCard");
        await plan.save({ session });
      }
    }

    await session.commitTransaction();
    session.endSession();

    res.status(200).json({ success: true, message: `Successfully switched ${services.length} services to ${targetProvider}` });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.error("Change Provider Error:", error);
    res.status(500).json({ success: false, message: "Internal server error", error: error.message });
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
