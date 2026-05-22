const express = require("express");
const router = express.Router();

const customRateController=require("../Users/saveCustomRateController");

router.post("/",customRateController.saveCustomRate);


module.exports=router;