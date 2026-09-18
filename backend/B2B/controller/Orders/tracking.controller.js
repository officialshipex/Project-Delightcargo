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
const {
  trackDelhiveryB2BShipmentInternal,
} = require("../Couriers/AllCouriers/Delhivery/Courier/couriers.controller");

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

// Maps Delhivery's B2B/LTL Track API status vocabulary (GET /lrn/track) to
// the same internal status vocabulary used above for Shiprocket Cargo.
// Confirmed from the docs site's own compiled JS (shipment-tracking chunk) —
// see trackDelhiveryB2BShipmentInternal for how the endpoint itself was found.
const KNOWN_DELHIVERY_B2B_STATUS_MAP = {
  MANIFESTED: "Ready To Ship",
  PICKED_UP: "In-transit",
  LEFT_ORIGIN: "In-transit",
  REACH_DESTINATION: "In-transit",
  // Delhivery's B2B API has no separate NDR/reattempt concept the way B2C
  // parcel delivery does, and there's no dedicated bucket for it in the B2B
  // order UI — treated as still in progress rather than invented into a
  // bucket that doesn't exist.
  UNDEL_REATTEMPT: "In-transit",
  OFD: "Out For Delivery",
  DELIVERED: "Delivered",
  RETURNED_INTRANSIT: "RTO In-transit",
  RECEIVED_AT_RETURN_CENTER: "RTO In-transit",
  RETURN_OFD: "RTO In-transit",
  RETURN_DELIVERED: "RTO Delivered",
  NOT_PICKED: "Not Picked",
  LOST: "Lost",
  // PART_DEL ("Partially Delivered") intentionally left unmapped — there's
  // no "partially delivered" bucket in the B2B order UI, and silently
  // folding it into either "Delivered" or "In-transit" would hide a real
  // exception from ops. Falls through to the unrecognized-status log below
  // instead of guessing.
};

const mapDelhiveryB2BStatus = (rawStatus) => {
  if (!rawStatus) return null;
  return KNOWN_DELHIVERY_B2B_STATUS_MAP[String(rawStatus).trim().toUpperCase()] || null;
};

// Fetches the latest status for one direct-Delhivery B2B order (booked with
// our own Delhivery LTL credentials, not through an aggregator) and updates
// it if changed. Used by the hourly cron below.
//
// Confirmed live response shape: { success, request_id, data: { lrnum,
// status, mcount, wbns: [{ status, location, wbn, scan_remark,
// scan_timestamp, manifested_date, ... }] } }. wbns[0] is the master
// waybill (all_wbns isn't passed, so only the master comes back).
const refreshDelhiveryB2BTracking = async (order) => {
  if (!order.lrn) return;

  const data = await trackDelhiveryB2BShipmentInternal(order.lrn, order.courierServiceName);
  if (!data) return;

  const lrData = data?.data;
  // A cancel response comes back as {success, request_id, data: "For LR
  // ..., Shipment has been cancelled..."} — data is a plain string, not the
  // object shape above. Nothing to extract a status from in that case.
  if (!lrData || typeof lrData !== "object") return;

  const masterWbn = Array.isArray(lrData.wbns) ? lrData.wbns[0] : null;
  const rawStatus = lrData.status || masterWbn?.status || null;

  // Delhivery's top-level `status` here doesn't have a CANCELLED value at
  // all — confirmed live: a shipment cancelled via DELETE /lrn/cancel
  // still reports status "MANIFESTED" here, with the cancellation visible
  // only as free text in the master waybill's scan_remark ("Seller
  // cancelled the order"). This is a heuristic (remark wording isn't a
  // documented API contract), not a structured signal, so it's checked
  // separately rather than folded into mapDelhiveryB2BStatus's table.
  const remark = masterWbn?.scan_remark || "";
  const isCancelledRemark = /cancel/i.test(remark);

  const mappedStatus = isCancelledRemark ? "Cancelled" : mapDelhiveryB2BStatus(rawStatus);

  if (!mappedStatus) {
    console.warn(
      `[Delhivery B2B Tracking] Order ${order.orderId} (LRN ${order.lrn}): unrecognized/unmapped status "${rawStatus}" — not updating status.`
    );
    return;
  }

  if (mappedStatus === order.status) return;

  if (mappedStatus === "Cancelled" && order.walletDeducted && !order.walletRefunded) {
    // This cron only syncs display status, unlike cancelB2BOrder/the
    // webhook/the async manifest fallback, which all refund off a
    // *structured* status field. Auto-refunding off a free-text remark
    // match felt like the wrong place to add that financial side effect —
    // flagging for manual reconciliation instead of silently crediting the
    // wallet here.
    console.warn(
      `[Delhivery B2B Tracking] Order ${order.orderId} (LRN ${order.lrn}) appears cancelled on Delhivery's side (remark: "${remark}") but wallet was never refunded — needs manual reconciliation.`
    );
  }

  // Delhivery's scan_timestamp/manifested_date come back as naive
  // "YYYY-MM-DDTHH:mm:ss" with no timezone marker — confirmed IST (cross-
  // checked manifested_date against when that manifest job actually
  // completed earlier this session). Appending "Z" forces those exact
  // digits to be read as the UTC components of the stored Date, which is
  // exactly what this codebase's StatusDateTime convention wants (see
  // below) — regardless of what timezone this server process itself runs in.
  const scanDate = masterWbn?.scan_timestamp ? new Date(`${masterWbn.scan_timestamp}Z`) : null;

  await Order.findByIdAndUpdate(order._id, {
    $set: { status: mappedStatus },
    $push: {
      tracking: {
        status: mappedStatus,
        Instructions: isCancelledRemark ? remark : (rawStatus ? `Delhivery status: ${rawStatus}` : "Status updated"),
        // Real per-waybill location, confirmed live (e.g. "Contai_Fatepur_DPP
        // (West Bengal)") — falls back to pickup city only if Delhivery
        // didn't return one for this scan.
        StatusLocation: masterWbn?.location || order.pickupAddress?.city || "N/A",
        StatusDateTime:
          scanDate && !isNaN(scanDate) ? scanDate : new Date(Date.now() + 5.5 * 60 * 60 * 1000),
      },
    },
  });
};

// Dispatches to the right courier's tracking refresh based on order.partner
// (the aggregator/platform the shipment was booked through — order.provider
// holds the real underlying carrier, e.g. "delhivery", which varies per
// shipment and isn't what identifies "this is a Shiprocket booking"). This is
// the single entry point the tracking cron (and anything else) should call.
// Shiprocket, BigShip and direct-Delhivery bookings all have live B2B
// tracking integrations now; other providers don't have one yet.
const refreshB2BOrderTracking = async (order) => {
  const partnerName = order.partner?.toLowerCase() || "";

  if (partnerName === "shiprocket") {
    return refreshShiprocketCargoTracking(order);
  }

  if (partnerName === "bigship") {
    return refreshBigShipOrderTracking(order);
  }

  // Direct Delhivery booking — no aggregator partner, or partner explicitly
  // "Delhivery" (mirrors the same partner-before-provider precedence used
  // for cancellation in orders.controller.js's cancelB2BOrder).
  if ((!order.partner || partnerName === "delhivery") && order.provider === "Delhivery") {
    return refreshDelhiveryB2BTracking(order);
  }

  // No B2B tracking integration yet for other providers.
};

// ─── Hourly cron: refreshes every in-flight B2B order's tracking status ──────
// Shiprocket Cargo has no webhook/callback, so polling is the only way to
// learn about status changes. Mirrors cron/ndrCron.js's pattern (node-cron,
// NODE_ENV=production gated, Asia/Kolkata timezone).

// "Not Picked" included so an order Delhivery couldn't pick up still gets
// re-checked on the next run (it can move forward once picked up on retry)
// instead of getting permanently orphaned by this same query.
const IN_FLIGHT_STATUSES = ["Ready To Ship", "Not Picked", "In-transit", "Out For Delivery", "RTO", "RTO In-transit"];
// 650ms stays under Delhivery's documented B2B rate limit (500 requests /
// 5 minutes ≈ 1 every 600ms) as well as comfortably inside Shiprocket's.
const DELAY_BETWEEN_CALLS_MS = 650;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const refreshAllB2BShiprocketTracking = async () => {
  try {
    // Name kept for backward compatibility (already referenced elsewhere by
    // this name) — covers every provider with a live B2B tracking
    // integration (Shiprocket, BigShip, direct Delhivery), not just
    // Shiprocket, since refreshB2BOrderTracking above dispatches by
    // partner/provider regardless of which one queried this order in.
    const orders = await Order.find({
      orderType: "B2B",
      status: { $in: IN_FLIGHT_STATUSES },
      $or: [
        { partner: { $in: ["Shiprocket", "BigShip"] }, awb_number: { $exists: true, $ne: null } },
        // Direct Delhivery: no partner (or partner explicitly "Delhivery")
        // and provider "Delhivery" — mirrors cancelB2BOrder's precedence.
        // Delhivery's B2B API is queried by LR number, not AWB.
        { provider: "Delhivery", partner: { $in: [null, "Delhivery"] }, lrn: { $exists: true, $ne: null } },
      ],
    });

    console.log(`[B2B Tracking] Checking ${orders.length} in-flight order(s).`);

    for (const order of orders) {
      try {
        await refreshB2BOrderTracking(order);
      } catch (err) {
        console.error(
          `[B2B Tracking] Failed for order ${order.orderId} (AWB ${order.awb_number || "-"}, LRN ${order.lrn || "-"}):`,
          err.message
        );
      }
      await sleep(DELAY_BETWEEN_CALLS_MS);
    }
  } catch (error) {
    console.error("[B2B Tracking] Error running tracking refresh:", error);
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
