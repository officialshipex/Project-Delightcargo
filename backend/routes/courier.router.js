const express = require("express");
const router = express.Router();
const { saveCourierPriority,getCourierServices,updateCourierServiceStatus } = require("../services/couriers.Controller");
const { isAuthorized } = require("../middleware/auth.middleware");

router.post("/saveCourierPriority", isAuthorized, saveCourierPriority);
router.get("/getCourierServices",isAuthorized,getCourierServices)
router.post("/updateCourierServiceStatus",isAuthorized,updateCourierServiceStatus)
 
module.exports = router;
