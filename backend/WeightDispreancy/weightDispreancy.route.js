const express = require("express");
const router = express.Router();
const multer = require("multer");
const upload = multer({ dest: "uploads/" });
const { uploads } = require("../config/s3");

const {
  downloadExcel,
  uploadDispreancy,
  AllDiscrepancy,
  getAllDiscrepancy,
  AllDiscrepancyBasedId,
  AllDiscrepancyCountBasedId,
  AcceptDiscrepancy,
  AcceptAllDiscrepancies,
  raiseDiscrepancies,
  adminAcceptDiscrepancy,
  declineDiscrepancy,
  bulkDeclineDiscrepancy,
  exportWeightDiscrepancy
} = require("./weightDispreancy.controller");

router.post("/upload", upload.single("file"), uploadDispreancy);
router.get("/download-excel", downloadExcel);
router.get("/allDispreancy", AllDiscrepancy);
router.get("/getAllDiscrepancy", getAllDiscrepancy);
router.get("/allDispreancyById", AllDiscrepancyBasedId);
router.get("/allDispreancyCountById", AllDiscrepancyCountBasedId);
router.post("/acceptDiscrepancy", AcceptDiscrepancy);
router.post("/acceptAllDiscrepancies", AcceptAllDiscrepancies);
router.post("/raiseDiscrepancies", uploads.single("image"), raiseDiscrepancies);
router.post("/adminAcceptDiscrepancy", adminAcceptDiscrepancy);
router.post("/declineDiscrepancy", declineDiscrepancy);
router.post("/bulkDeclineDiscrepancy", bulkDeclineDiscrepancy);
router.post("/exportWeightDiscrepancy", exportWeightDiscrepancy);
// router.get("/all", getAllPosts);

module.exports = router;
