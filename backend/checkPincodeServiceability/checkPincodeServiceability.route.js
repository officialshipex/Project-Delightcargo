// routes/courierRoutes.js
const express = require("express");
const router = express.Router();
const multer = require("multer");
const { uploadPincode, downloadPincode,getCourierServiceabilityStats } = require("./checkPincodeServiceability.controller");

const upload = multer({ dest: "uploads/" });

router.post("/:courier/upload-pincode", upload.single("file"), uploadPincode);
router.get("/:courier/download-pincode", downloadPincode);
router.get("/summary", getCourierServiceabilityStats);

module.exports = router;
