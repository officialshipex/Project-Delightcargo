const express = require("express");
const router = express.Router();
const { adminGetInvoices, userGetInvoices,scheduleMonthlyInvoiceCron,bulkDownloadInvoices } = require("./invoice.controller");
const {isAuthorized} = require("../middleware/auth.middleware");

// Admin route
router.get("/adminGetInvoices", isAuthorized, adminGetInvoices);

// User route
router.get("/userGetInvoices", isAuthorized, userGetInvoices);

router.get("/bulk-download", bulkDownloadInvoices);


module.exports = router;
    