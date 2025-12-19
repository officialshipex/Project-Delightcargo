const express = require("express");
const router = express.Router();
const { isAuthorized } = require("../middleware/auth.middleware");
const {
  adminB2BOrders,
  userB2BOrders,
} = require("./controller/Orders/orders.controller");
const zoneMatrix = require("./controller/ZoneMatrix/zoneController");
const ratecard = require("./controller/RateCard/ratecard.controller");
const {
  getAllCouriers,
  createCourier,
  updateCourierServicesStatus,
  updateCourier,
  getAllCourierServices,
  updateCourierStatus,
  deleteCourier,
  uploadPincode,
  downloadPincode,
  loadCourierPincodes,
} = require("./controller/Couriers/couriers.controller");
const shiprocketRouter = require("./controller/Couriers/AllCourierRoutes/shiprocket.router");

router.get("/getb2badminorder", adminB2BOrders);
router.get("/getb2buserorder", isAuthorized, userB2BOrders);
router.get("/zonematrix/getAll", isAuthorized, zoneMatrix.getAll);
router.post("/zonematrix/addLocation", isAuthorized, zoneMatrix.addLocation);
router.put(
  "/zonematrix/removeLocation",
  isAuthorized,
  zoneMatrix.removeLocation
);
router.delete(
  "/zonematrix/removeZone/:id",
  isAuthorized,
  zoneMatrix.removeZone
);
router.get(
  "/zonematrix/lookup/pincode",
  isAuthorized,
  zoneMatrix.lookupPincode
);

router.get("/ratecard/getMeta", isAuthorized, ratecard.getMeta);
router.get("/ratecard/getRateCard", isAuthorized, ratecard.getRateCard);
router.post("/ratecard/createRateCard", isAuthorized, ratecard.createRateCard);
router.put(
  "/ratecard/updateRateCard/:id",
  isAuthorized,
  ratecard.updateRateCard
);
router.delete(
  "/ratecard/deleteRateCard/:id",
  isAuthorized,
  ratecard.deleteRateCard
);
router.post("/ratecard/copyRateCard", isAuthorized, ratecard.copyRateCard);

router.get("/couriers/getAllCouriers", getAllCouriers);
router.post("/couriers/updateCourierStatus", updateCourierStatus);
router.delete("/couriers/deleteCourier/:id", deleteCourier);
router.post("/couriers/:courier/uploadPincode",uploadPincode)
router.get("/couriers/:courier/downloadPincode",downloadPincode)
router.use("/shiprocket", shiprocketRouter);

router.get("/courierServices/getAllCourierServices", getAllCourierServices);
router.post("/courierServices/createCourier", createCourier);
router.put(
  "/courierServices/updateCourierServicesStatus/:id",
  updateCourierServicesStatus
);
router.put("/courierServices/updateCourier/:id", updateCourier);

module.exports = router;
