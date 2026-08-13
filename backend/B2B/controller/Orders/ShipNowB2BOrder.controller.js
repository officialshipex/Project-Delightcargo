const ZoneMatrix = require("../../models/zoneMatrix.model");
const Order = require("../../../models/newOrder.model");
const Plan = require("../../models/plan.model");
const B2BRateCard = require("../../models/ratecard.model");
const courierServiceB2B = require("../../models/courierService.model");
const {
  getCargoServiceableCouriers,
} = require("../Couriers/AllCouriers/ShipRocket/Courier/couriers.controller");
const {checkDelhiveryServiceability}=require("../Couriers/AllCouriers/Delhivery/Courier/couriers.controller")

// Rate-calculation helpers live in a shared, dependency-free util so the
// booking controllers (Shiprocket/Delhivery) can reuse them without creating
// a circular require with this file (which already imports from them above).
const {
  normalize,
  getZoneByCityOrState,
  calculateChargeableWeight,
  calculateOverhead,
  resolveDivisor,
  calculateCodCharge,
  calculateB2BCargoRate,
} = require("../../utils/b2bRateEngine");

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
      const cacheKey = provider?.toLowerCase() === "delhivery" ? rc.courierServiceName : provider;
      if (!serviceabilityCache[cacheKey]) {
        serviceabilityCache[cacheKey] = await checkB2BServiceability({
          provider,
          order,
          packages: order.B2BPackageDetails.packages,
          courierServiceName: rc.courierServiceName,
        });
      }

      const serviceability = serviceabilityCache[cacheKey];

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

      // Shiprocket's aggregator match already tells us whether this exact
      // route is confirmed remote — use it so the preview only shows ODA/OPA
      // when it's actually warranted. Non-aggregator providers (e.g.
      // Delhivery) have no such signal yet, so isODA stays at its default
      // (always charge), unchanged from before.
      const working = calculateB2BCargoRate({
        rateCard: rc,
        fromZone,
        toZone,
        packages: order.B2BPackageDetails.packages,
        minWeight,
        isCOD,
        orderValue,
        rovType: order.rovType,
        ...(matchedService ? { isODA: Boolean(matchedService.isODA) } : {}),
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

const checkB2BServiceability = async ({ provider, order, packages, courierServiceName }) => {
  const providerName = provider?.toLowerCase() || "";

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
      courierServiceName, // pass so it can fetch correct credentials
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
  checkB2BServiceability,
};
