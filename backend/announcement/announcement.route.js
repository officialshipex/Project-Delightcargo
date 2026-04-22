const express = require("express");
const router = express.Router();
const announcementController = require("./announcement.controller");
const { isAuthorized } = require("../middleware/auth.middleware");

// User routes
router.get("/active", isAuthorized, announcementController.getActiveAnnouncement);

// Admin routes (assuming admin check is done in middleware or by path in routes.js)
router.post("/create", isAuthorized, announcementController.createAnnouncement);
router.get("/all", isAuthorized, announcementController.getAllAnnouncements);
router.put("/update/:id", isAuthorized, announcementController.updateAnnouncement);
router.delete("/delete/:id", isAuthorized, announcementController.deleteAnnouncement);

module.exports = router;
