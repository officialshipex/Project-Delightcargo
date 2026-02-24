const express = require("express");
const router = express.Router();
const multer = require('multer');
const { isAuthorized } = require("../middleware/auth.middleware");
const {
  adminB2BOrders,
  userB2BOrders,
  generatePickupController
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
  getShiprocketCourierServices
} = require("./controller/Couriers/couriers.controller");
const shiprocketRouter = require("./controller/Couriers/AllCourierRoutes/shiprocket.router");
const delhiveryRouter = require("./controller/Couriers/AllCourierRoutes/delhivery.router")
const {
  ShipNowB2BOrder,
} = require("./controller/Orders/ShipNowB2BOrder.controller");

const {
  getPickupManifests,
  getManifestOrders,
  schedulePickup
} = require("./controller/Orders/pickupManifest.controller");

const { getB2BPackages, updateB2BPackages } = require("./controller/Orders/b2bPackage.controller");

const { CalculateB2BRateWithoutOrder } = require("./controller/Orders/rateCalculator.controller");

const { generateLabel } = require("./controller/labelInvoiceManifest/label.controller");

const { downloadSampleExcelB2B, bulkOrderB2B } = require("./controller/Orders/addBulkOrder.controller");


router.get("/getb2badminorder", isAuthorized, adminB2BOrders);
router.get("/pickupManifests", isAuthorized, getPickupManifests);
router.get("/pickupManifest/:manifestId", isAuthorized, getManifestOrders);
router.get("/getb2buserorder", isAuthorized, userB2BOrders);
router.post("/generatePickup", isAuthorized, generatePickupController)
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
router.post("/saveRate/createPlanName", isAuthorized, ratecard.createPlanName);
router.get("/saveRate/getPlanNames", isAuthorized, ratecard.getPlanNames);
router.get("/saveRate/getRateCard", isAuthorized, ratecard.getRateCardName);

router.get("/couriers/getAllCouriers", getAllCouriers);
router.post("/couriers/updateCourierStatus", updateCourierStatus);
router.delete("/couriers/deleteCourier/:id", deleteCourier);
router.post("/couriers/:courier/uploadPincode", uploadPincode);
router.get("/couriers/:courier/downloadPincode", downloadPincode);
router.get("/couriers/getShiprocketCourierServices", getShiprocketCourierServices);


router.use("/shiprocket", shiprocketRouter);
router.use("/delhivery", delhiveryRouter)

router.get("/courierServices/getAllCourierServices", getAllCourierServices);
router.post("/courierServices/createCourier", createCourier);
router.put(
  "/courierServices/updateCourierServicesStatus/:id",
  updateCourierServicesStatus
);
router.put("/courierServices/updateCourier/:id", updateCourier);

router.get("/shipNow/:id", isAuthorized, ShipNowB2BOrder);

router.get(
  "/orders/:orderId/b2b-packages",
  getB2BPackages
);

router.put(
  "/orders/:orderId/b2b-packages",
  updateB2BPackages
);

router.get("/generate-label/:id", generateLabel);

router.post("/rateCalculator/calculateB2BRateWithoutOrder", isAuthorized, CalculateB2BRateWithoutOrder);

const upload = multer({ dest: 'uploads/' });
router.get("/bulkOrderUpload/download-excel", isAuthorized, downloadSampleExcelB2B);
router.post("/bulkOrderUpload/upload", upload.single('file'), isAuthorized, bulkOrderB2B);

module.exports = router;
