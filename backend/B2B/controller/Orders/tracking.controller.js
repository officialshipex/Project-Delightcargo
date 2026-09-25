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
  "manifested": "Ready To Ship",
  "not picked": "Not Picked",
  "not picked up": "Not Picked",
  "shipment not received from client": "Not Picked",
  "shipper unavailable": "Not Picked",
  "picked up": "In-transit",
  "in transit": "In-transit",
  "reached at destination": "In-transit",
  "out for delivery": "Out For Delivery",
  "delivered": "Delivered",
  "cancelled": "Cancelled",
  "canceled": "Cancelled",
  "rto": "RTO",
  "rto delivered": "RTO Delivered",
  "rto in-transit": "RTO In-transit",
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
  if (
    normalized.includes("not picked") ||
    normalized.includes("not_picked") ||
    normalized.includes("unavailable") ||
    normalized.includes("not received")
  ) {
    return "Not Picked";
  }
  if (normalized.includes("archived")) return "Not Picked";

  return null;
};

// Fetches the latest status for one B2B Shiprocket order and updates it if
// changed. Used by the hourly cron registered at the bottom of this file.
const refreshShiprocketCargoTracking = async (order) => {
  if (!order.awb_number) return;

  const data = await trackShiprocketCargoShipmentInternal(order.awb_number);
  if (!data) return;

  const historyList = Array.isArray(data.status_history) ? data.status_history : [];
  const latestHistory = historyList.length > 0 ? historyList[historyList.length - 1] : null;

  // Gather status candidates in order of specificity:
  // 1. latestHistory.status_code (e.g. 'Not Picked')
  // 2. latestHistory.status (e.g. 'Pickup Scheduled')
  // 3. latestHistory.reason / remarks (e.g. 'Shipment not received from client')
  // 4. data.status (e.g. 'Archived', 'Delivered', 'In Transit')
  // 5. data.status_dp
  const candidates = [
    latestHistory?.status_code,
    latestHistory?.status,
    latestHistory?.reason,
    latestHistory?.remarks,
    data.status,
    data.status_dp,
  ];

  let mappedStatus = null;
  for (const cand of candidates) {
    if (!cand) continue;
    mappedStatus = mapShiprocketCargoStatus(cand);
    if (mappedStatus) break;
  }

  if (!mappedStatus) {
    console.warn(
      `[Shiprocket Cargo Tracking] Order ${order.orderId} (AWB ${order.awb_number}): unrecognized status "${data.status}" / "${data.status_dp}" — not updating status.`
    );
    return;
  }

  const instructions =
    latestHistory?.remarks ||
    latestHistory?.reason ||
    data.status_dp ||
    data.status ||
    "Status updated";

  const location =
    latestHistory?.location ||
    data.from_city ||
    order.pickupAddress?.city ||
    "N/A";

  const statusDateTime = latestHistory?.timestamp
    ? new Date(`${latestHistory.timestamp}Z`)
    : new Date(Date.now() + 5.5 * 60 * 60 * 1000);

  const update = {};
  if (mappedStatus !== order.status) {
    update.$set = { status: mappedStatus };
    update.$push = {
      tracking: {
        status: mappedStatus,
        Instructions: instructions,
        StatusLocation: location,
        StatusDateTime: statusDateTime,
      },
    };
  }

  if (data.edd_date && data.edd_date !== "Estimated Delivery Date not found") {
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
  const upper = String(rawStatus).trim().toUpperCase();
  const normalized = upper.replace(/\s+/g, "_");

  if (KNOWN_DELHIVERY_B2B_STATUS_MAP[normalized]) {
    return KNOWN_DELHIVERY_B2B_STATUS_MAP[normalized];
  }
  if (KNOWN_DELHIVERY_B2B_STATUS_MAP[upper]) {
    return KNOWN_DELHIVERY_B2B_STATUS_MAP[upper];
  }

  if (normalized.includes("NOT_PICKED") || normalized.includes("UNPICKED")) return "Not Picked";
  if (normalized.includes("CANCEL")) return "Cancelled";
  if (normalized.includes("DELIVER")) return "Delivered";
  if (normalized.includes("TRANSIT") || normalized.includes("ORIGIN") || normalized.includes("DESTINATION")) return "In-transit";

  return null;
};

// Fetches the latest status for one direct-Delhivery B2B order (booked with
// our own Delhivery LTL credentials, not through an aggregator) and updates
// it if changed. Used by the hourly cron below.
const refreshDelhiveryB2BTracking = async (order) => {
  const lrnToTrack = order.lrn || order.awb_number;
  if (!lrnToTrack) return;

  const data = await trackDelhiveryB2BShipmentInternal(lrnToTrack, order.courierServiceName);
  if (!data) return;

  const lrData = data?.data;
  // A cancel response comes back as {success, request_id, data: "For LR
  // ..., Shipment has been cancelled..."} — data is a plain string, not the
  // object shape above. Nothing to extract a status from in that case.
  if (!lrData || typeof lrData !== "object") return;

  const masterWbn = Array.isArray(lrData.wbns) ? lrData.wbns[0] : null;
  const rawStatus = lrData.status || masterWbn?.status || null;

  const remark = masterWbn?.scan_remark || "";
  const isCancelledRemark = /cancel/i.test(remark);

  const mappedStatus = isCancelledRemark ? "Cancelled" : mapDelhiveryB2BStatus(rawStatus);

  if (!mappedStatus) {
    console.warn(
      `[Delhivery B2B Tracking] Order ${order.orderId} (LRN ${lrnToTrack}): unrecognized/unmapped status "${rawStatus}" — not updating status.`
    );
    return;
  }

  if (mappedStatus === order.status) return;

  if (mappedStatus === "Cancelled" && order.walletDeducted && !order.walletRefunded) {
    console.warn(
      `[Delhivery B2B Tracking] Order ${order.orderId} (LRN ${lrnToTrack}) appears cancelled on Delhivery's side (remark: "${remark}") but wallet was never refunded — needs manual reconciliation.`
    );
  }

  const scanDate = masterWbn?.scan_timestamp ? new Date(`${masterWbn.scan_timestamp}Z`) : null;

  await Order.findByIdAndUpdate(order._id, {
    $set: { status: mappedStatus },
    $push: {
      tracking: {
        status: mappedStatus,
        Instructions: isCancelledRemark ? remark : (remark ? remark : (rawStatus ? `Delhivery status: ${rawStatus}` : "Status updated")),
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
  const providerName = order.provider?.toLowerCase() || "";
  const serviceName = order.courierServiceName?.toLowerCase() || "";

  if (partnerName === "shiprocket") {
    return refreshShiprocketCargoTracking(order);
  }

  if (partnerName === "bigship") {
    return refreshBigShipOrderTracking(order);
  }

  // Direct Delhivery booking — no aggregator partner, or partner explicitly
  // "Delhivery" (mirrors the same partner-before-provider precedence used
  // for cancellation in orders.controller.js's cancelB2BOrder).
  if (
    (!order.partner || partnerName === "delhivery") &&
    (providerName === "delhivery" || serviceName.includes("delhivery"))
  ) {
    return refreshDelhiveryB2BTracking(order);
  }

  // No B2B tracking integration yet for other providers.
};

// ─── Hourly cron: refreshes every in-flight B2B order's tracking status ──────
const IN_FLIGHT_STATUSES = ["Ready To Ship", "Not Picked", "In-transit", "Out For Delivery", "RTO", "RTO In-transit"];
const DELAY_BETWEEN_CALLS_MS = 650;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const refreshAllB2BShiprocketTracking = async () => {
  try {
    const orders = await Order.find({
      orderType: "B2B",
      status: { $in: IN_FLIGHT_STATUSES },
      $or: [
        { partner: { $in: ["Shiprocket", "BigShip"] }, awb_number: { $exists: true, $ne: null } },
        // Direct Delhivery: provider or courierServiceName Delhivery
        {
          $or: [
            { provider: { $regex: /^delhivery$/i } },
            { courierServiceName: { $regex: /delhivery/i } }
          ],
          partner: { $in: [null, "", "Delhivery", "delhivery"] },
          $or: [
            { lrn: { $exists: true, $ne: null, $ne: "" } },
            { awb_number: { $exists: true, $ne: null, $ne: "" } }
          ]
        },
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
  mapDelhiveryB2BStatus,
  refreshDelhiveryB2BTracking,
  refreshB2BOrderTracking,
  refreshAllB2BShiprocketTracking,
};
