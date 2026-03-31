const express = require("express");
const router = express.Router();
const {
  saveCostingRate,
  getAllCostingRates,
  getCostingRateById,
  updateCostingRate,
  deleteCostingRate,
} = require("../Rate/costingRateCardController");

router.post("/save", saveCostingRate);
router.get("/getAll", getAllCostingRates);
router.get("/get/:id", getCostingRateById);
router.put("/update/:id", updateCostingRate);
router.delete("/delete/:id", deleteCostingRate);

module.exports = router;
