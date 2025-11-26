const express = require('express');


const  {saveEkart}= require('../AllCouriers/Ekart/Authorize/Ekart.controller');
const { orderCreationEkart } = require('../AllCouriers/Ekart/Couriers/couriers.controller');

const router = express.Router();




router.post("/authorize",saveEkart);
router.post("/createShipment",orderCreationEkart);


module.exports = router;