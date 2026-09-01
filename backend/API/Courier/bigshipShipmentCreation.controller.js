// Thin wrapper matching every other file in this directory's shape (a single
// default-exported creation function) — the actual booking logic already
// lives in AllCouriers/BigShip/Courier/couriers.controller.js (kept there,
// not duplicated here, to avoid a circular require with that file's own
// Express handler which needs the same internal helpers).
const { createBigShipShipment } = require("../../AllCouriers/BigShip/Courier/couriers.controller");

module.exports = createBigShipShipment;
