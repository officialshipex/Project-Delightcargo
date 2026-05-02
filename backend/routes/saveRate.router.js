const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const upload = multer({ dest: "uploads/" });
const saveRateController = require("../Rate/saveRateCardController");
const {isAuthorized}=require("../middleware/auth.middleware")
const { uploadRatecard,deleteRateCard } = require("../Rate/saveRateCardController");




router.get("/getRateCard",saveRateController.getRateCard)

router.get('/getRateCard/:id', saveRateController.getRateCardById); // Use the ID in the URL
router.put("/updateRateCard/:id", isAuthorized, saveRateController.updateRateCard);
router.delete("/deleteRateCard/:id", isAuthorized, deleteRateCard)
router.post("/saveB2CRate", isAuthorized, saveRateController.saveRate);

router.get("/getPlan",isAuthorized,saveRateController.getPlan)
router.post("/createPlanName",isAuthorized,saveRateController.createPlanName);
router.get("/getPlanNames",saveRateController.getPlanNames);
router.get("/download-excel", saveRateController.exportDemoRatecard)
router.post("/uploadRatecard", isAuthorized, upload.single("file"), uploadRatecard);


module.exports = router;

