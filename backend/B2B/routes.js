const express=require("express");
const router=express.Router();
const {isAuthorized}=require("../middleware/auth.middleware")
const {adminB2BOrders,userB2BOrders}=require("./controller/Orders/orders.controller");


router.get("/getb2badminorder",adminB2BOrders);
router.get("/getb2buserorder",isAuthorized,userB2BOrders)

module.exports=router;