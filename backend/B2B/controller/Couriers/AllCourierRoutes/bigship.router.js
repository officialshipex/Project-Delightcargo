const express = require("express");
const router = express.Router();

// BigShip credentials are shared between B2C and B2B (one account, segment_type
// differentiates per-call) — reuses the same save/token module B2C uses rather
// than a separate credential store.
const { saveBigShip } = require("../../../../AllCouriers/BigShip/Authorize/bigship.controller");
const { createBigShipCargoShipment } = require("../AllCouriers/BigShip/Courier/couriers.controller");

router.post("/getToken", saveBigShip);
router.post("/createShipment", createBigShipCargoShipment);

module.exports = router;
