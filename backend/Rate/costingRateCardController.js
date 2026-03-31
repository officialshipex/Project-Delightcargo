const CostingRateCard = require("../models/costingRateCard.model");
const RateCard = require("../models/rateCards");
const CourierService = require("../models/CourierService.Schema");

// ─────────────────────────────────────────────
// Helper: compute numeric delta per zone/field
// ─────────────────────────────────────────────
const calcDelta = (oldVal, newVal) => {
  const o = parseFloat(oldVal) || 0;
  const n = parseFloat(newVal) || 0;
  return n - o;
};

// ─────────────────────────────────────────────
// POST /costingRate/save
// ─────────────────────────────────────────────
const saveCostingRate = async (req, res) => {
  try {
    const {
      courierServiceName,
      mode,
      status,
      shipmentType,
      weightPriceBasic,
      weightPriceAdditional,
      codPercent,
      codCharge,
    } = req.body;

    if (!courierServiceName) {
      return res.status(400).json({ message: "Courier Service Name is required" });
    }

    const existing = await CostingRateCard.findOne({ courierServiceName });

    if (existing) {
      // Simply update (no bulk propagation on ADD — propagation only on EDIT)
      existing.mode = mode || existing.mode;
      existing.status = status || existing.status;
      existing.shipmentType = shipmentType || existing.shipmentType;
      existing.weightPriceBasic = weightPriceBasic;
      existing.weightPriceAdditional = weightPriceAdditional;
      existing.codPercent = parseFloat(codPercent) || 0;
      existing.codCharge = parseFloat(codCharge) || 0;
      await existing.save();

      return res.status(201).json({
        message: `Costing rate card for ${courierServiceName} updated successfully.`,
      });
    }

    const doc = new CostingRateCard({
      courierServiceName,
      mode: mode || "",
      status: status || "Active",
      shipmentType: shipmentType || "Forward",
      weightPriceBasic,
      weightPriceAdditional,
      codPercent: parseFloat(codPercent) || 0,
      codCharge: parseFloat(codCharge) || 0,
    });

    await doc.save();
    return res.status(201).json({
      message: `Costing rate card for ${courierServiceName} saved successfully.`,
    });
  } catch (error) {
    console.error("saveCostingRate error:", error);
    res.status(500).json({ message: "Error saving costing rate card", error: error.message });
  }
};

// ─────────────────────────────────────────────
// GET /costingRate/getAll
// ─────────────────────────────────────────────
const getAllCostingRates = async (req, res) => {
  try {
    const rates = await CostingRateCard.find().sort({ createdAt: -1 });
    res.status(200).json({ costingRateCards: rates });
  } catch (error) {
    console.error("getAllCostingRates error:", error);
    res.status(500).json({ message: "Error fetching costing rate cards" });
  }
};

// ─────────────────────────────────────────────
// GET /costingRate/get/:id
// ─────────────────────────────────────────────
const getCostingRateById = async (req, res) => {
  try {
    const { id } = req.params;
    const rate = await CostingRateCard.findById(id);
    if (!rate) return res.status(404).json({ message: "Costing rate card not found" });
    res.status(200).json({ costingRateCard: rate });
  } catch (error) {
    console.error("getCostingRateById error:", error);
    res.status(500).json({ message: "Error fetching costing rate card" });
  }
};

// ─────────────────────────────────────────────
// PUT /costingRate/update/:id
// Core logic: calculate delta → apply to all RateCards with same courierServiceName
// ─────────────────────────────────────────────
const updateCostingRate = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      courierServiceName,
      mode,
      status,
      shipmentType,
      weightPriceBasic,
      weightPriceAdditional,
      codPercent,
      codCharge,
    } = req.body;

    // 1. Fetch current (old) costing rate card
    const oldCostingRate = await CostingRateCard.findById(id);
    if (!oldCostingRate) {
      return res.status(404).json({ message: "Costing rate card not found" });
    }

    // 2. Compute deltas for basic weights
    //    Old and new arrays should correspond by index
    const basicDeltas = weightPriceBasic.map((newRow, i) => {
      const oldRow = oldCostingRate.weightPriceBasic[i] || { zoneA: 0, zoneB: 0, zoneC: 0, zoneD: 0, zoneE: 0 };
      return {
        zoneA: calcDelta(oldRow.zoneA, newRow.zoneA),
        zoneB: calcDelta(oldRow.zoneB, newRow.zoneB),
        zoneC: calcDelta(oldRow.zoneC, newRow.zoneC),
        zoneD: calcDelta(oldRow.zoneD, newRow.zoneD),
        zoneE: calcDelta(oldRow.zoneE, newRow.zoneE),
      };
    });

    const additionalDeltas = weightPriceAdditional.map((newRow, i) => {
      const oldRow = oldCostingRate.weightPriceAdditional[i] || { zoneA: 0, zoneB: 0, zoneC: 0, zoneD: 0, zoneE: 0 };
      return {
        zoneA: calcDelta(oldRow.zoneA, newRow.zoneA),
        zoneB: calcDelta(oldRow.zoneB, newRow.zoneB),
        zoneC: calcDelta(oldRow.zoneC, newRow.zoneC),
        zoneD: calcDelta(oldRow.zoneD, newRow.zoneD),
        zoneE: calcDelta(oldRow.zoneE, newRow.zoneE),
      };
    });

    const codChargeAtom = calcDelta(oldCostingRate.codCharge, codCharge);
    const codPercentDelta = calcDelta(oldCostingRate.codPercent, codPercent);

    // 3. Fetch all RateCards with the same courierServiceName
    const allMatchingRateCards = await RateCard.find({ courierServiceName });

    let updatedCount = 0;

    // 4. Apply deltas to each matching rate card
    for (const rc of allMatchingRateCards) {
      // Apply basic deltas
      rc.weightPriceBasic = rc.weightPriceBasic.map((row, i) => {
        const delta = basicDeltas[i] || { zoneA: 0, zoneB: 0, zoneC: 0, zoneD: 0, zoneE: 0 };
        return {
          ...row.toObject ? row.toObject() : row,
          zoneA: parseFloat((parseFloat(row.zoneA) + delta.zoneA).toFixed(2)),
          zoneB: parseFloat((parseFloat(row.zoneB) + delta.zoneB).toFixed(2)),
          zoneC: parseFloat((parseFloat(row.zoneC) + delta.zoneC).toFixed(2)),
          zoneD: parseFloat((parseFloat(row.zoneD) + delta.zoneD).toFixed(2)),
          zoneE: parseFloat((parseFloat(row.zoneE) + delta.zoneE).toFixed(2)),
        };
      });

      // Apply additional deltas
      rc.weightPriceAdditional = rc.weightPriceAdditional.map((row, i) => {
        const delta = additionalDeltas[i] || { zoneA: 0, zoneB: 0, zoneC: 0, zoneD: 0, zoneE: 0 };
        return {
          ...row.toObject ? row.toObject() : row,
          zoneA: parseFloat((parseFloat(row.zoneA) + delta.zoneA).toFixed(2)),
          zoneB: parseFloat((parseFloat(row.zoneB) + delta.zoneB).toFixed(2)),
          zoneC: parseFloat((parseFloat(row.zoneC) + delta.zoneC).toFixed(2)),
          zoneD: parseFloat((parseFloat(row.zoneD) + delta.zoneD).toFixed(2)),
          zoneE: parseFloat((parseFloat(row.zoneE) + delta.zoneE).toFixed(2)),
        };
      });

      // Apply COD deltas
      rc.codCharge = parseFloat((parseFloat(rc.codCharge) + codChargeAtom).toFixed(2));
      rc.codPercent = parseFloat((parseFloat(rc.codPercent) + codPercentDelta).toFixed(2));

      await rc.save();
      updatedCount++;
    }

    // 5. Update the costing rate card itself with new values
    oldCostingRate.mode = mode || oldCostingRate.mode;
    oldCostingRate.status = status || oldCostingRate.status;
    oldCostingRate.shipmentType = shipmentType || oldCostingRate.shipmentType;
    oldCostingRate.weightPriceBasic = weightPriceBasic;
    oldCostingRate.weightPriceAdditional = weightPriceAdditional;
    oldCostingRate.codPercent = parseFloat(codPercent) || 0;
    oldCostingRate.codCharge = parseFloat(codCharge) || 0;
    await oldCostingRate.save();

    return res.status(200).json({
      message: `Costing rate card updated. Delta applied to ${updatedCount} rate card(s) for service "${courierServiceName}".`,
      updatedRateCardCount: updatedCount,
    });
  } catch (error) {
    console.error("updateCostingRate error:", error);
    res.status(500).json({ message: "Error updating costing rate card", error: error.message });
  }
};

// ─────────────────────────────────────────────
// DELETE /costingRate/delete/:id
// ─────────────────────────────────────────────
const deleteCostingRate = async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await CostingRateCard.findByIdAndDelete(id);
    if (!deleted) return res.status(404).json({ message: "Costing rate card not found" });
    res.status(200).json({ message: "Costing rate card deleted successfully." });
  } catch (error) {
    console.error("deleteCostingRate error:", error);
    res.status(500).json({ message: "Error deleting costing rate card" });
  }
};

module.exports = {
  saveCostingRate,
  getAllCostingRates,
  getCostingRateById,
  updateCostingRate,
  deleteCostingRate,
};
