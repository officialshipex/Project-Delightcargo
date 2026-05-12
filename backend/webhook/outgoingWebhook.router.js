const express = require("express");
const router = express.Router();
const { isAuthorized } = require("../middleware/auth.middleware");
const {
  createWebhook,
  getWebhooks,
  updateWebhook,
  deleteWebhook,
  getWebhookLogs,
  getWebhookLogById,
  testWebhook,
} = require("./outgoingWebhook.controller");

router.use(isAuthorized);

router.post("/", createWebhook);
router.get("/", getWebhooks);
router.put("/:id", updateWebhook);
router.delete("/:id", deleteWebhook);
router.get("/logs", getWebhookLogs);
router.get("/logs/:id", getWebhookLogById);
router.post("/:id/test", testWebhook);

module.exports = router;

