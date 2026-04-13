const express = require("express");
const router = express.Router();
const {getReferralStats,generateMonthlyReferralReport,getAllReferralStats,withdrawCommission}=require("./referal.controller");
const { isAuthorized } = require("../middleware/auth.middleware");
router.get("/stats",isAuthorized,getReferralStats);
router.post("/withdraw",isAuthorized,withdrawCommission);
router.get("/getAllReferralStats",getAllReferralStats);

module.exports = router;