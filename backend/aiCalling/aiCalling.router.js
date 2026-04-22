const express = require("express");
const router = express.Router();
const {
  initiateAiCall,
  aiCallCallback,
  getAiCallLogs,
  getAiCallingSettings,
  updateAiCallingSettings,
} = require("./aiCalling.controller");
const { isAuthorized } = require("../middleware/auth.middleware");

// 🔓 Public - called by EchQ after call completes
router.post("/callback", aiCallCallback);

// 🔐 Protected - user/admin routes
router.post("/initiate", isAuthorized, initiateAiCall);
router.get("/logs", isAuthorized, getAiCallLogs);
router.get("/settings", isAuthorized, getAiCallingSettings);
router.put("/settings", isAuthorized, updateAiCallingSettings);

module.exports = router;
