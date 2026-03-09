const express = require("express");
const router = express.Router();
const { saveBoxdLogistics } = require("../AllCouriers/BoxdLogistics/Authorize/boxdLogistics.controller");
const { createBoxdLogisticsOrder } = require("../AllCouriers/BoxdLogistics/Courier/couriers.controller");

router.post("/addCourier", saveBoxdLogistics);
router.post("/createShipment", createBoxdLogisticsOrder);

module.exports = router;
