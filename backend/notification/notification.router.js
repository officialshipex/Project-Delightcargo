const express = require("express");
const {
  getNotificationSettings,
  updateNotificationSetting,
  buyCredits,
  getCreditBalance,
  getUserPassbookTransactions,
  updateAdminNotificationForAllUsers,
} = require("./notification.controller.js");
const { isAuthorized } = require("../middleware/auth.middleware.js");

const router = express.Router();

router.get("/getNotification", isAuthorized, getNotificationSettings);
router.put("/updateNotification", isAuthorized, updateNotificationSetting);
router.post("/buyCredits", isAuthorized, buyCredits);
router.get("/getCreditBalance", isAuthorized, getCreditBalance);
router.get("/getUserPassbookTransactions", isAuthorized, getUserPassbookTransactions);

module.exports = router;
