
const express = require("express");
const router = express.Router();

const {getToken}=require("../AllCouriers/Delhivery/Authorize/delhivery.controller")
// const {createShiprocketCargoShipment}=require("../AllCouriers/ShipRocket/Courier/couriers.controller")

// router.post('/createShipment', createShiprocketCargoShipment);



// router.post('/getToken', getToken);


module.exports = router
