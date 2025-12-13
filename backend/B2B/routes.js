const express=require("express");
const router=express.Router();
const {isAuthorized}=require("../middleware/auth.middleware")
const {adminB2BOrders,userB2BOrders}=require("./controller/Orders/orders.controller");
const zoneMatrix=require("./controller/ZoneMatrix/zoneController")


router.get("/getb2badminorder",adminB2BOrders);
router.get("/getb2buserorder",isAuthorized,userB2BOrders)
router.get("/zonematrix/getAll", zoneMatrix.getAll);
router.post("/zonematrix/addLocation", zoneMatrix.addLocation);
router.put("/zonematrix/removeLocation", zoneMatrix.removeLocation);
router.delete("/zonematrix/removeZone/:id", zoneMatrix.removeZone);
router.get("/zonematrix/lookup/pincode", zoneMatrix.lookupPincode);

module.exports=router;