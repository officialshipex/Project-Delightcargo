const express = require("express");
const router = express.Router();

const customRateController=require("../Users/saveCustomRateController");

router.post("/",customRateController.saveCustomRate);
router.post("/accept",customRateController.acceptCustomRate);
router.post("/reject",customRateController.rejectCustomRate);

module.exports=router;