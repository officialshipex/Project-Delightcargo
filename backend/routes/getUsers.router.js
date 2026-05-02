const express = require("express");
const router = express.Router();

const userController=require("../Users/usersController");

const {isAuthorized} = require('../middleware/auth.middleware')

router.get("/getUsers",isAuthorized, userController.getUsers);
router.get("/getAllUsers",isAuthorized,userController.getAllUsers)
router.put("/assignPlan", isAuthorized, userController.assignPlan);
router.put("/assign/plan", isAuthorized, userController.B2BassignPlan);

router.post("/getRateCard",userController.getRatecards);
router.get("/getUserServices", isAuthorized, userController.getUserServices);
router.post("/toggleProviderStatus", isAuthorized, userController.toggleProviderStatus);
router.post("/toggleServiceStatus", isAuthorized, userController.toggleServiceStatus);
router.post("/updateServiceRate", isAuthorized, userController.updateServiceRate);


module.exports=router;