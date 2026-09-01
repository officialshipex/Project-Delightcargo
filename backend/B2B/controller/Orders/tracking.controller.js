const cron = require("node-cron");
const Order = require("../../../models/newOrder.model");
const {
  trackShiprocketCargoShipmentInternal,
} = require("../Couriers/AllCouriers/ShipRocket/Courier/couriers.controller");
// BigShip serves both B2C and B2B off one account, so its tracking logic
// (fetch + status-map + update) lives once in the shared B2C module and is
// reused here rather than duplicated — it's already segment-agnostic.
const {
  refreshBigShipOrderTracking,
} = require("../../../AllCouriers/BigShip/Courier/couriers.controller");

// Maps Shiprocket Cargo's own status string to the internal status vocabulary
// the frontend actually filters on (pulled from DelightcargoFrontend/src/B2B/Orders/*.jsx).
// Shiprocket's docs don't give an exhaustive status enum — only a handful of
// examples are shown in their sample responses (Created, Picked Up, In Transit,
// Reached At Destination, Out For Delivery, Delivered, Pickup Scheduled). The
// known table below covers those; anything else falls through to a defensive
// keyword match, and if even that doesn't match, we log it and leave the
// order's status untouched rather than guess.
const KNOWN_SHIPROCKET_CARGO_STATUS_MAP = {
  "pickup scheduled": "Ready To Ship",
  "created": "Ready To Ship",
  "picked up": "In-transit",
  "in transit": "In-transit",
  "reached at destination": "In-transit",
  "out for delivery": "Out For Delivery",
  "delivered": "Delivered",
};

const mapShiprocketCargoStatus = (rawStatus) => {
  if (!rawStatus) return null;
  const normalized = String(rawStatus).trim().toLowerCase();

  if (KNOWN_SHIPROCKET_CARGO_STATUS_MAP[normalized]) {
    return KNOWN_SHIPROCKET_CARGO_STATUS_MAP[normalized];
  }

  // Defensive fallback for statuses not seen in Shiprocket's documented samples
  if (normalized.includes("rto")) {
    if (normalized.includes("deliver")) return "RTO Delivered";
    if (normalized.includes("transit") || normalized.includes("reached")) return "RTO In-transit";
    if (normalized.includes("lost")) return "RTO Lost";
    if (normalized.includes("damage")) return "RTO Damaged";
    return "RTO";
  }
  if (normalized.includes("cancel")) return "Cancelled";
  if (normalized.includes("lost")) return "Lost";
  if (normalized.includes("damage")) return "Damaged";
  if (normalized.includes("deliver")) return "Delivered";
  if (normalized.includes("transit")) return "In-transit";

  return null;
};

// Fetches the latest status for one B2B Shiprocket order and updates it if
// changed. Used by the hourly cron registered at the bottom of this file.
const refreshShiprocketCargoTracking = async (order) => {
  if (!order.awb_number) return;

  const data = await trackShiprocketCargoShipmentInternal(order.awb_number);
  if (!data) return;

  const mappedStatus = mapShiprocketCargoStatus(data.status || data.status_dp);

  if (!mappedStatus) {
    console.warn(
      `[Shiprocket Cargo Tracking] Order ${order.orderId} (AWB ${order.awb_number}): unrecognized status "${data.status}" / "${data.status_dp}" — not updating status.`
    );
    return;
  }

  const update = {};
  if (mappedStatus !== order.status) {
    update.$set = { status: mappedStatus };
    update.$push = {
      tracking: {
        status: mappedStatus,
        Instructions: data.status_dp || data.status || "Status updated",
        StatusDateTime: new Date(Date.now() + 5.5 * 60 * 60 * 1000),
      },
    };
  }

  if (data.edd_date) {
    update.$set = { ...(update.$set || {}), estimatedDeliveryDate: data.edd_date };
  }

  if (Object.keys(update).length > 0) {
    await Order.findByIdAndUpdate(order._id, update);
  }
};

// Dispatches to the right courier's tracking refresh based on order.partner
// (the aggregator/platform the shipment was booked through — order.provider
// holds the real underlying carrier, e.g. "delhivery", which varies per
// shipment and isn't what identifies "this is a Shiprocket booking"). This is
// the single entry point the tracking cron (and anything else) should call.
// Currently Shiprocket and BigShip have live B2B tracking integrations; other
// providers (e.g. Delhivery, which isn't booked through an aggregator) don't
// have one yet, so this is a no-op for them.
const refreshB2BOrderTracking = async (order) => {
  const partnerName = order.partner?.toLowerCase() || "";

  if (partnerName === "shiprocket") {
    return refreshShiprocketCargoTracking(order);
  }

  if (partnerName === "bigship") {
    return refreshBigShipOrderTracking(order);
  }

  // No B2B tracking integration yet for other providers.
};

// ─── Hourly cron: refreshes every in-flight B2B order's tracking status ──────
// Shiprocket Cargo has no webhook/callback, so polling is the only way to
// learn about status changes. Mirrors cron/ndrCron.js's pattern (node-cron,
// NODE_ENV=production gated, Asia/Kolkata timezone).

const IN_FLIGHT_STATUSES = ["Ready To Ship", "In-transit", "Out For Delivery", "RTO", "RTO In-transit"];
const DELAY_BETWEEN_CALLS_MS = 300; // stay well inside Shiprocket's rate limit

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const refreshAllB2BShiprocketTracking = async () => {
  try {
    // Name kept for backward compatibility (already referenced elsewhere by
    // this name) — covers every aggregator with a live B2B tracking
    // integration, not just Shiprocket, since refreshB2BOrderTracking above
    // dispatches by partner regardless of which one queried this order in.
    const orders = await Order.find({
      orderType: "B2B",
      partner: { $in: ["Shiprocket", "BigShip"] },
      awb_number: { $exists: true, $ne: null },
      status: { $in: IN_FLIGHT_STATUSES },
    });

    console.log(`[B2B Tracking] Checking ${orders.length} in-flight order(s).`);

    for (const order of orders) {
      try {
        await refreshB2BOrderTracking(order);
      } catch (err) {
        console.error(
          `[B2B Shiprocket Tracking] Failed for order ${order.orderId} (AWB ${order.awb_number}):`,
          err.message
        );
      }
      await sleep(DELAY_BETWEEN_CALLS_MS);
    }
  } catch (error) {
    console.error("[B2B Shiprocket Tracking] Error running tracking refresh:", error);
  }
};

console.log("B2B Shiprocket Cargo Tracking Cron Initialized: Hourly status refresh.");

if (process.env.NODE_ENV === "production") {
  // Offset from ndrCron's "5 * * * *" so they don't fire in the same minute.
  cron.schedule("10 * * * *", async () => {
    console.log("Running Hourly B2B Shiprocket Cargo Tracking Job...");
    await refreshAllB2BShiprocketTracking();
  }, {
    scheduled: true,
    timezone: "Asia/Kolkata"
  });
}

module.exports = {
  mapShiprocketCargoStatus,
  refreshShiprocketCargoTracking,
  refreshB2BOrderTracking,
  refreshAllB2BShiprocketTracking,
};
