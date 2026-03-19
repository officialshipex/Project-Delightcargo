const express = require("express");
const router = express.Router();
const { saveProship } = require("../AllCouriers/Proship/Authorize/proship.controller");
const { createProshipOrder } = require("../AllCouriers/Proship/Courier/couriers.controller");

router.post("/getAuthToken", saveProship);
router.post("/createShipment", createProshipOrder);

module.exports = router;
