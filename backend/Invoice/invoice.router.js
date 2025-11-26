const express = require("express");
const router = express.Router();
const { adminGetInvoices, userGetInvoices,scheduleMonthlyInvoiceCron } = require("./invoice.controller");
const {isAuthorized} = require("../middleware/auth.middleware");

// Admin route
router.get("/adminGetInvoices", isAuthorized, adminGetInvoices);

// User route
router.get("/userGetInvoices", isAuthorized, userGetInvoices);

module.exports = router;
    