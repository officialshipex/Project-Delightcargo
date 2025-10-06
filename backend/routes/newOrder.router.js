const express = require("express");
const {
  newOrder,
  getOrders,
  getOrdersByNdrStatus,
  updatedStatusOrders,
  getOrdersById,
  getpickupAddress,
  newPickupAddress,
  newReciveAddress,
  getreceiverAddress,
  ShipeNowOrder,
  getPinCodeDetails,
  cancelOrdersAtNotShipped,
  cancelOrdersAtBooked,
  // tracking,
  updateOrder,
  passbook,
  getUser,
  updatePackageDetails,
  GetTrackingByAwb,
  GetTrackingByAwbs,
  updatePickupAddress,
  setPrimaryPickupAddress,
  deletePickupAddress,
  getShippingOrders
  // calculateRTOCharges
  
} = require("../Orders/newOrder.controller"); // Adjust path to your controller
const router = express.Router();

// Route to create a shipment
router.put("/updateOrder/:orderId", updateOrder);
router.post("/neworder", newOrder);
router.get("/orders", getOrders);
router.get("/shippingOrders",getShippingOrders)
router.get("/ndr",getOrdersByNdrStatus);
router.post("/clone",updatedStatusOrders)
router.get("/getOrderById/:id",getOrdersById)
router.get("/pickupAddress", getpickupAddress);
router.get("/receiverAddress", getreceiverAddress);
router.post("/pickupAddress", newPickupAddress);
router.post("/receiverAddress", newReciveAddress);
router.get("/ship/:id", ShipeNowOrder);
router.get("/pincode/:pincode", getPinCodeDetails);
router.post("/cancelOrdersAtNotShipped",cancelOrdersAtNotShipped)
router.post("/cancelOrdersAtBooked",cancelOrdersAtBooked)

router.post("/updatePackageDetails",updatePackageDetails)
router.get("/passbook",passbook)
router.get("/getUser",getUser)
// router.post("/webhookTracking",trackOrders)
router.get("/GetTrackingByAwb/:awb",GetTrackingByAwb)
router.post("/GetTrackingByAwbs",GetTrackingByAwbs)
router.put("/updatePickupAddress/:id",updatePickupAddress)
router.patch("/pickupAddress/setPrimary/:id",setPrimaryPickupAddress)
router.delete("/pickupAddress/:id",deletePickupAddress)
// router.post("/calculateRTOCharges",calculateRTOCharges)
module.exports = router;
