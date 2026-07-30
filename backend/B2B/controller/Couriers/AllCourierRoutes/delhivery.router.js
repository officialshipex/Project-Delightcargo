
const express = require("express");
const router = express.Router();

const {getToken}=require("../AllCouriers/Delhivery/Authorize/delhivery.controller")
const {createDelhiveryB2BShipment}=require("../AllCouriers/Delhivery/Courier/couriers.controller")

router.post('/createShipment', createDelhiveryB2BShipment);
router.post('/getToken', getToken);

module.exports = router
