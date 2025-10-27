const express = require("express");
const router = express.Router();
const {getReferralStats,generateMonthlyReferralReport,getAllReferralStats}=require("./referal.controller");
const { isAuthorized } = require("../middleware/auth.middleware");
router.get("/stats",isAuthorized,getReferralStats);
router.get("/getAllReferralStats",getAllReferralStats);

module.exports = router;