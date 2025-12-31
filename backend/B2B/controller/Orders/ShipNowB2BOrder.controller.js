const ZoneMatrix = require("../../models/zoneMatrix.model");
const Order = require("../../../models/newOrder.model");
const Plan = require("../../../models/Plan.model");
const B2BRateCard = require("../../models/ratecard.model");
const courierServiceB2B = require("../../models/courierService.model");
const {
  getCargoServiceableCouriers,
} = require("../Couriers/AllCouriers/ShipRocket/Courier/couriers.controller");

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
    deadWeight += pkg.noOfBox * pkg.weightPerBox;

    volumetricWeight +=
      (pkg.length * pkg.width * pkg.height * pkg.noOfBox) / divisor;
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

  const flat = Number(codConfig.flat || 0);
  const percent = Number(codConfig.percent || 0);

  const percentValue = (orderValue * percent) / 100;
  let codCharge = Math.max(flat, percentValue);

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
  const divisor = resolveDivisor(rateCard.overheadCharges?.divisor);

  // 1️⃣ actual chargeable weight
  const actualChargeableWeight = calculateChargeableWeight(packages, divisor);

  // 2️⃣ apply minimum courier weight
  const billableWeight = Math.max(actualChargeableWeight, minWeight);

  const rateCell = rateCard.rates.find(
    (r) =>
      normalize(r.fromZone) === normalize(fromZone) &&
      normalize(r.toZone) === normalize(toZone)
  );
  if (!rateCell) return null;

  const ratePerKg = rateCell.price;

  // 🔥 FREIGHT ON BILLABLE WEIGHT
  const freight = billableWeight * ratePerKg;

  const overheads = rateCard.overheadCharges || {};

  const awb = calculateOverhead(overheads.awbCharges, freight, billableWeight);
  let rov = 0;

  if (rovType === "ROV Carrier") {
    rov = calculateOverhead(overheads.rovCarrier, freight, billableWeight);
  } else {
    // Default → ROV Owner
    rov = calculateOverhead(overheads.rovOwner, freight, billableWeight);
  }

  const fsc = calculateOverhead(
    overheads.fuelSurcharge,
    freight,
    billableWeight
  );
  const oda = calculateOverhead(overheads.odaCharges, freight, billableWeight);
  const green = calculateOverhead(
    overheads.greenCharges,
    freight,
    billableWeight
  );

  const codCharge = isCOD
    ? calculateCodCharge({
        codConfig: overheads.cod,
        orderValue,
      })
    : 0;

  const subtotal = freight + awb + rov + fsc + oda + green + codCharge;
  const gstRate = overheads.gst?.value || 18;
  const gst = (subtotal * gstRate) / 100;

  return {
    actual_chargeable_weight: +actualChargeableWeight.toFixed(2),
    min_weight_applied: minWeight,
    billable_weight: +billableWeight.toFixed(2),

    rate: ratePerKg,
    freight: +freight.toFixed(2),
    cod_charges: codCharge,
    awb_charges: awb,
    rov,
    fsc,
    oda,
    green_tax: green,

    total: +subtotal.toFixed(2),
    gst: +gst.toFixed(2),
    grand_total: +(subtotal + gst).toFixed(2),
  };
};

const ShipNowB2BOrder = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order || order.orderType !== "B2B") {
      return res.status(400).json({ message: "Invalid B2B order" });
    }

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

    // ✅ ONLY ACTIVE RATE CARDS
    const rateCards = (plan.B2BRateCard || []).filter(
      (rc) => rc.status?.toLowerCase() === "active"
    );

    if (!rateCards.length) {
      return res.status(200).json({
        success: true,
        message: "No active B2B rate cards found",
        rates: [],
      });
    }

    const results = [];

    // 🔍 SHIPROCKET SERVICEABILITY CHECK (ONCE)
    const serviceableCouriers = await getCargoServiceableCouriers({
      order,
      packages: order.B2BPackageDetails.packages,
    });
    // console.log("Serviceable Couriers:", serviceableCouriers);

    for (const rc of rateCards) {
      // const providerName = rc.courierServiceName?.toLowerCase()?.trim();

      // ❌ Skip non-serviceable courier
      // if (!serviceableCouriers.has(providerName)) {
      //   continue;
      // }

      const courier = await courierServiceB2B
        .findById(rc.courierService)
        .select("weight")
        .select("courier");
      // console.log("Evaluating Courier Service:", courier);

      const serviceName = courier?.courier?.toLowerCase()?.trim() || "";
      // console.log("Evaluating Courier Service:", serviceName);
      // ❌ Skip non-serviceable courier
      if (!serviceableCouriers.includes(serviceName)) {
        continue;
      }

      const minWeight = courier?.weight || 10;
      const isCOD = order.paymentDetails?.method?.toUpperCase() === "COD";
      const orderValue = Number(order.paymentDetails?.amount || 0);

      const working = calculateB2BCargoRate({
        rateCard: rc,
        fromZone,
        toZone,
        packages: order.B2BPackageDetails.packages,
        minWeight,
        isCOD,
        orderValue,
        rovType: order.rovType,
      });

      if (!working) continue;

      results.push({
        courierServiceName: rc.courierServiceName,
        provider: rc.courierProviderName,
        mode_name: rc.courierServiceName.toLowerCase().includes("air")
          ? "air"
          : "surface",
        working,
        tat: 3,
      });
    }

    results.sort((a, b) => a.working.grand_total - b.working.grand_total);

    // console.log("B2B ShipNow Results:", results);

    res.status(200).json({
      success: true,
      orderId: order.orderId,
      zone: { fromZone, toZone },
      rates: results,
      order,
    });
  } catch (err) {
    console.error("B2B ShipNow Error:", err);
    res.status(500).json({ error: err.message });
  }
};

module.exports = {
  ShipNowB2BOrder,
  getZoneByCityOrState,
  calculateChargeableWeight,
  calculateOverhead,
  resolveDivisor,
  calculateCodCharge,
  calculateB2BCargoRate,
};
