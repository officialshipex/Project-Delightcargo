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

  switch (overhead.type) {
    case "percentage":
      value = (base * overhead.value) / 100;
      break;

    case "perKg":
      value = weight * overhead.value;
      break;

    case "flat":
      value = overhead.value;
      break;

    case "formula":
      value = eval(overhead.value); // controlled formulas only
      break;
  }

  if (overhead.min && value < overhead.min) {
    value = overhead.min;
  }

  return Number(value.toFixed(2));
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

  const percentValue = (orderValue * Number(codConfig.value || 0)) / 100;
  let codCharge = percentValue;

  if (codConfig.min && codCharge < codConfig.min) {
    codCharge = codConfig.min;
  }

  return Number(codCharge.toFixed(2));
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
}) => {
  const divisor = Number(rateCard.overheadCharges?.divisor.value);
  const actualChargeableWeight = calculateChargeableWeight(packages, divisor);
  const billableWeight = Math.max(actualChargeableWeight, minWeight);

  const rateCell = rateCard.rates.find(
    (r) =>
      normalize(r.fromZone) === normalize(fromZone) &&
      normalize(r.toZone) === normalize(toZone)
  );
  if (!rateCell) return null;

  const ratePerKg = rateCell.price;
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
  const oda = calculateOverhead(overheads.odaCharges, freight, billableWeight);
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
  const appointment = calculateOverhead(
    overheads.appointmentDelivery,
    freight,
    billableWeight
  );

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
  if (overheads.minimumFreight && subtotal < overheads.minimumFreight.value) {
    subtotal = overheads.minimumFreight.value;
  }

  const gstRate = overheads.gst?.value || 18;
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
const getAuthoritativeB2BRate = async ({ order, provider, courierServiceName }) => {
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

    const working = calculateB2BCargoRate({
      rateCard: rc,
      fromZone,
      toZone,
      packages: order.B2BPackageDetails.packages,
      minWeight: courier.weight || 10,
      isCOD,
      orderValue,
      rovType: order.rovType,
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
