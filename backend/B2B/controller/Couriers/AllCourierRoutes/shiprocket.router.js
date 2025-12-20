
const express = require("express");
const router = express.Router();

const {getToken}=require("../AllCouriers/ShipRocket/Authorize/shiprocket.controller")
const {createShiprocketCargoShipment}=require("../AllCouriers/ShipRocket/Courier/couriers.controller")

router.post('/createShiprocketCargoShipment', createShiprocketCargoShipment);



router.post('/getToken', getToken);


module.exports = router
