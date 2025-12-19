
const express = require("express");
const router = express.Router();

const {getToken}=require("../AllCouriers/ShipRocket/Authorize/shiprocket.controller")



router.post('/getToken', getToken);


module.exports = router
