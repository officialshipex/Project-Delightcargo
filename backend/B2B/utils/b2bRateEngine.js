const ZoneMatrix = require("../models/zoneMatrix.model");
const Plan = require("../models/plan.model");
const courierServiceB2B = require("../models/courierService.model");

// Shared B2B rate-calculation engine. Kept dependency-free from the courier
// controllers (Shiprocket/Delhivery) and ShipNowB2BOrder.controller.js so all
// three can import it without creating a circular require between them.

const normalize = (str) => str?.toLowerCase().replace(/\s+/g, "").trim();

const getZoneByCityOrState = async (city, state) => {
  const zones = await ZoneMatrix.find();

  const normCity = normalize(city);
  const normState = normalize(state);

  // 1️⃣ Try match by CITY
  for (const z of zones) {
    if (z.locations.some((l) => normalize(l.name) === normCity)) {
      return z.zone;
    }
  }

  // 2️⃣ Fallback: Try match by STATE
  for (const z of zones) {
    if (z.locations.some((l) => normalize(l.name) === normState)) {
      return z.zone;
    }
  }

  // 3️⃣ Nothing matched
  throw new Error(`Zone not found for city "${city}" or state "${state}"`);
};

const calculateChargeableWeight = (packages, divisor = 5000) => {
  let deadWeight = 0;
  let volumetricWeight = 0;
  for (const pkg of packages) {
    deadWeight += Number(pkg.noOfBox) * Number(pkg.weightPerBox);

    volumetricWeight +=
      (Number(pkg.length) *
        Number(pkg.width) *
        Number(pkg.height) *
        Number(pkg.noOfBox)) /
      divisor;
  }
  return Math.max(deadWeight, volumetricWeight);
};

const calculateOverhead = (overhead, base, weight) => {
  if (!overhead || !overhead.type) return 0;

  let value = 0;
  const numBase = Number(base || 0);
  const numWeight = Number(weight || 0);
  const numValue = Number(overhead.value || 0);

  switch (overhead.type) {
    case "percentage":
      value = (numBase * numValue) / 100;
      break;

    case "perKg":
      value = numWeight * numValue;
      break;

    case "flat":
      value = numValue;
      break;

    case "formula":
      try {
        value = Number(eval(overhead.value)) || 0;
      } catch (e) {
        value = 0;
      }
      break;
  }

  const numMin = Number(overhead.min || 0);
  if (numMin > 0 && value < numMin) {
    value = numMin;
  }

  return Number((Number(value) || 0).toFixed(2));
};

const resolveDivisor = (divisorConfig) => {
  if (!divisorConfig) return 5000;

  // Case 1: Numeric divisor
  if (typeof divisorConfig.value === "number") {
    return divisorConfig.value;
  }

  // Case 2: Formula string like "(L*W*H)/4500"
  if (typeof divisorConfig.value === "string") {
    const match = divisorConfig.value.match(/\/\s*(\d+)/);
    if (match) {
      return Number(match[1]); // 👉 4500
    }
  }

  // Fallback
  return 5000;
};

const calculateCodCharge = ({ codConfig, orderValue }) => {
  if (!codConfig) return 0;

  const numVal = Number(codConfig.value || 0);
  const numOrderVal = Number(orderValue || 0);
  const percentValue = (numOrderVal * numVal) / 100;
  let codCharge = percentValue;

  const numMin = Number(codConfig.min || 0);
  if (numMin > 0 && codCharge < numMin) {
    codCharge = numMin;
  }

  return Number((Number(codCharge) || 0).toFixed(2));
};

const calculateB2BCargoRate = ({
  rateCard,
  fromZone,
  toZone,
  packages,
  minWeight = 10,
  isCOD = false,
  orderValue = 0,
  rovType = "ROV Owner",
  isAppointment = false,
  // Defaults to true (always charge) to preserve existing behavior for any
  // caller that doesn't have a live remoteness signal (e.g. Delhivery isn't
  // wired up to check this yet). Shiprocket's booking flow passes the real
  // value once it has live serviceability data for the actual route.
  isODA = true,
}) => {
  const divisor = Number(rateCard.overheadCharges?.divisor?.value) || 5000;
  const actualChargeableWeight = calculateChargeableWeight(packages, divisor);
  const billableWeight = Math.max(actualChargeableWeight, minWeight);

  const rateCell = rateCard.rates.find(
    (r) =>
      normalize(r.fromZone) === normalize(fromZone) &&
      normalize(r.toZone) === normalize(toZone)
  );
  if (!rateCell) return null;

  const ratePerKg = Number(rateCell.price || 0);
  const freight = billableWeight * ratePerKg;

  const overheads = rateCard.overheadCharges || {};

  const docket = calculateOverhead(
    overheads.docketCharge,
    freight,
    billableWeight
  );

  const rov =
    rovType === "ROV Carrier"
      ? calculateOverhead(overheads.rovCarrier, freight, billableWeight)
      : calculateOverhead(overheads.rovOwner, freight, billableWeight);

  const fsc = calculateOverhead(overheads.fuelCharge, freight, billableWeight);
  // Only charge ODA/OPA when the route is actually confirmed remote — see
  // isODA default comment above for why this defaults to "always charge".
  const oda = isODA
    ? calculateOverhead(overheads.odaCharges, freight, billableWeight)
    : 0;
  const green = calculateOverhead(overheads.greenTax, freight, billableWeight);
  const pickup = calculateOverhead(
    overheads.pickupCharge,
    freight,
    billableWeight
  );
  const handling = calculateOverhead(
    overheads.handlingCharge,
    freight,
    billableWeight
  );
  // Only charge for appointment delivery when the shipment actually is one —
  // otherwise every order (including the vast majority that never request
  // it) would silently absorb this charge's minimum floor.
  const appointment = isAppointment
    ? calculateOverhead(overheads.appointmentDelivery, freight, billableWeight)
    : 0;

  const codCharge = isCOD
    ? calculateCodCharge({
        codConfig: overheads.codCharges,
        orderValue,
      })
    : 0;

  let subtotal =
    freight +
    docket +
    rov +
    fsc +
    oda +
    green +
    pickup +
    handling +
    appointment +
    codCharge;

  // 🔒 Minimum Freight
  if (overheads.minimumFreight && overheads.minimumFreight.value && subtotal < Number(overheads.minimumFreight.value)) {
    subtotal = Number(overheads.minimumFreight.value);
  }

  const gstRate = Number(overheads.gst?.value) || 18;
  const gst = (subtotal * gstRate) / 100;

  return {
    actual_chargeable_weight: +actualChargeableWeight.toFixed(2),
    billable_weight: +billableWeight.toFixed(2),

    rate: ratePerKg,
    freight: +freight.toFixed(2),

    docket_charges: docket,
    pickup_charge: pickup,
    handling_charge: handling,
    appointment_charge: appointment,
    cod_charges: codCharge,
    rov,
    fsc,
    oda,
    green_tax: green,

    subtotal: +subtotal.toFixed(2),
    gst: +gst.toFixed(2),
    grand_total: +(subtotal + gst).toFixed(2),
  };
};

// Recomputes the authoritative charge for a booking server-side, by finding
// the matching ACTIVE rate-card line for this order's user/provider/service
// and running it through calculateB2BCargoRate — instead of trusting a
// client-supplied finalCharges/rateBreakup, which a tampered or buggy request
// could otherwise set to anything before it gets debited from the wallet.
// liveServiceability (optional): the array Shiprocket's live charges API
// returns (each entry { key, isODA, ... }), when the caller has already
// fetched it for this exact order. Used to only charge ODA/OPA when the
// route is actually confirmed remote, instead of always. Deliberately kept
// out of this shared engine's own responsibilities (it has no knowledge of
// Shiprocket's API) — the caller fetches it and passes it in.
const getAuthoritativeB2BRate = async ({ order, provider, courierServiceName, liveServiceability }) => {
  const plan = await Plan.findOne({ userId: order.userId });
  if (!plan) throw new Error("Plan not found");

  const fromZone = await getZoneByCityOrState(
    order.pickupAddress.city,
    order.pickupAddress.state
  );
  const toZone = await getZoneByCityOrState(
    order.receiverAddress.city,
    order.receiverAddress.state
  );

  const rateCards = (plan.B2BRateCard || []).filter(
    (rc) => rc.status?.toLowerCase() === "active"
  );

  const isCOD = order.paymentDetails?.method?.toUpperCase() === "COD";
  const orderValue = Number(order.paymentDetails?.amount || 0);

  for (const rc of rateCards) {
    if (rc.courierProviderName?.toLowerCase() !== provider?.toLowerCase()) continue;
    if (rc.courierServiceName !== courierServiceName) continue;

    const courier = await courierServiceB2B.findById(rc.courierService).select("weight courier");
    if (!courier) continue;

    let isODA = true;
    if (liveServiceability) {
      const match = liveServiceability.find((s) => s.key === courier.courier);
      if (match) isODA = Boolean(match.isODA);
    }

    const working = calculateB2BCargoRate({
      rateCard: rc,
      fromZone,
      toZone,
      packages: order.B2BPackageDetails.packages,
      minWeight: courier.weight || 10,
      isCOD,
      orderValue,
      rovType: order.rovType,
      isODA,
    });

    if (!working) continue;

    return { working, rateCard: rc };
  }

  throw new Error(
    `No active rate card found for ${provider} / "${courierServiceName}" for this order`
  );
};

module.exports = {
  normalize,
  getZoneByCityOrState,
  calculateChargeableWeight,
  calculateOverhead,
  resolveDivisor,
  calculateCodCharge,
  calculateB2BCargoRate,
  getAuthoritativeB2BRate,
};
