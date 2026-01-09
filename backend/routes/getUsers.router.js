const express = require("express");
const router = express.Router();

const userController=require("../Users/usersController");

const {isAuthorized} = require('../middleware/auth.middleware')

router.get("/getUsers",isAuthorized, userController.getUsers);
router.get("/getAllUsers",isAuthorized,userController.getAllUsers)
router.put("/assignPlan", userController.assignPlan);
router.put("/assign/plan", userController.B2BassignPlan);

router.post("/getRateCard",userController.getRatecards);

module.exports=router;