const express = require("express");
const router = express.Router();
const axios = require('axios');

const {getAuthToken,saveNimbusPost,isEnabeled,disable,enable}=require("../AllCouriers/NimbusPost/Authorize/nimbuspost.controller");
const nimbuspostCourierController=require("../AllCouriers/NimbusPost/Courier/couriers.controller");


router.get('/saveNew',saveNimbusPost);
router.get('/isEnabeled',isEnabeled);
router.get('/disable',disable);
router.get('/enable',enable);

router.post("/getAuthToken",getAuthToken);



router.get("/getCourierServices",nimbuspostCourierController.getCouriers);
router.post("/addService",nimbuspostCourierController.addService);

router.post("/getServiceablePincodes",nimbuspostCourierController.getServiceablePincodes);
// router.post("/getServiceablePincodesData",nimbuspostCourierController.getServiceablePincodesData);

router.post("/createShipment",nimbuspostCourierController.createShipment);
// router.post("/trackShipment",nimbuspostCourierController.trackShipment);
router.post("/trackShipmentInBulk",nimbuspostCourierController.trackShipmentsInBulk);
router.post("/manifest",nimbuspostCourierController.manifest);
router.post("/cancelShipment",nimbuspostCourierController.cancelShipment);
router.post("/hyperLocalShipment",nimbuspostCourierController.createHyperlocalShipment);


module.exports=router;



