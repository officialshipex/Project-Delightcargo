const ZoneMatrix = require("../../models/zoneMatrix.model");
const Order = require("../../../models/newOrder.model");
const Plan = require("../../models/plan.model");
const B2BRateCard = require("../../models/ratecard.model");
const courierServiceB2B = require("../../models/courierService.model");
const {
  getCargoServiceableCouriers,
} = require("../Couriers/AllCouriers/ShipRocket/Courier/couriers.controller");
const {checkDelhiveryServiceability}=require("../Couriers/AllCouriers/Delhivery/Courier/couriers.controller")

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
  // console.log("divisor",divisor)
  // console.log("packages",packages)
  for (const pkg of packages) {
    deadWeight += Number(pkg.noOfBox) * Number(pkg.weightPerBox);

    volumetricWeight +=
      (Number(pkg.length) *
        Number(pkg.width) *
        Number(pkg.height) *
        Number(pkg.noOfBox)) /
      divisor;
  }
  // console.log("dead weight", deadWeight);
  // console.log("volumetric", volumetricWeight);
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
  // console.log("rate",rateCard)
  const divisor = Number(rateCard.overheadCharges?.divisor.value);
  console.log("divisor", divisor);
  const actualChargeableWeight = calculateChargeableWeight(packages, divisor);
  const billableWeight = Math.max(actualChargeableWeight, minWeight);

  const rateCell = rateCard.rates.find(
    (r) =>
      normalize(r.fromZone) === normalize(fromZone) &&
      normalize(r.toZone) === normalize(toZone)
  );
  if (!rateCell) return null;

  const ratePerKg = rateCell.price;
  // console.log("billable", billableWeight);
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

    // 🔹 Cache serviceability PER PROVIDER
    const serviceabilityCache = {};

    for (const rc of rateCards) {
      const courier = await courierServiceB2B
        .findById(rc.courierService)
        .select("weight courier");

      if (!courier) continue;

      const serviceName = courier.courier?.trim() || "";
      const provider = rc.courierProviderName;

      // ===============================
      // SERVICEABILITY CHECK (ONCE PER PROVIDER)
      // ===============================
      if (!serviceabilityCache[provider]) {
        serviceabilityCache[provider] = await checkB2BServiceability({
          provider,
          order,
          packages: order.B2BPackageDetails.packages,
        });
      }

      const serviceability = serviceabilityCache[provider];

      // ===============================
      // AGGREGATOR (SHIPROCKET)
      // ===============================
      let matchedService = null;

      if (serviceability.type === "aggregator") {
        matchedService = serviceability.couriers.find(
          (s) => s.key === serviceName
        );

        if (!matchedService) continue;
      }

      // ===============================
      // DIRECT COURIER (DELHIVERY / DTDC)
      // ===============================
      if (serviceability.type === "direct" && !serviceability.serviceable) {
        continue;
      }

      // ===============================
      // RATE CALCULATION
      // ===============================
      const minWeight = courier.weight || 10;
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

      // ===============================
      // PUSH RESULT
      // ===============================
      results.push({
        courierServiceName: rc.courierServiceName,
        provider,
        mode_name: rc.courierServiceName.toLowerCase().includes("air")
          ? "air"
          : "surface",
        working,
        tat: 3,
        serviceId: matchedService?.id || null,
        modeId: matchedService?.modeId || null,
      });
    }

    results.sort((a, b) => a.working.grand_total - b.working.grand_total);

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

const checkB2BServiceability = async ({ provider, order, packages }) => {
  const providerName = provider.toLowerCase();

  // ===============================
  // SHIPROCKET (AGGREGATOR)
  // ===============================
  if (providerName === "shiprocket") {
    const couriers = await getCargoServiceableCouriers({
      order,
      packages,
    });

    return {
      type: "aggregator",
      couriers: couriers || [], // [{ key, id, modeId }]
    };
  }

  // ===============================
  // DELHIVERY (DIRECT)
  // ===============================
  if (providerName === "delhivery") {
    const isServiceable = await checkDelhiveryServiceability({
      order,
      packages,
    });

    return {
      type: "direct",
      serviceable: isServiceable,
    };
  }

  // ===============================
  // DEFAULT DIRECT COURIER
  // ===============================
  return {
    type: "direct",
    serviceable: true,
  };
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
