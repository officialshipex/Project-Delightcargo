const ZoneMatrix = require("../../models/zoneMatrix.model");
const Plan = require("../../models/plan.model");
const courierServiceB2B = require("../../models/courierService.model");
const { findByPincode } = require("../../pincodeLoader");

const {
  getZoneByCityOrState,
  calculateB2BCargoRate,
  checkB2BServiceability,
} = require("./ShipNowB2BOrder.controller");

const CalculateB2BRateWithoutOrder = async (req, res) => {
  try {
    const {
      pickupPincode,
      deliveryPincode,
      paymentType,
      paymentValue,
      packages,
      rovType = "ROV Owner",
    } = req.body;

    const userId = req.user._id;

    /* ================= PLAN ================= */
    const plan = await Plan.findOne({ userId });
    if (!plan) throw new Error("Plan not found");

    /* ================= PINCODE → CITY/STATE ================= */
    const pickup = await findByPincode(pickupPincode);
    if (!pickup) {
      throw new Error(`Invalid pickup pincode: ${pickupPincode}`);
    }

    const delivery = await findByPincode(deliveryPincode);
    if (!delivery) {
      throw new Error(`Invalid delivery pincode: ${deliveryPincode}`);
    }

    const pickupCity = pickup.city;
    const pickupState = pickup.state;
    const deliveryCity = delivery.city;
    const deliveryState = delivery.state;

    /* ================= ZONE RESOLUTION ================= */
    const fromZone = await getZoneByCityOrState(pickupCity, pickupState);
    const toZone = await getZoneByCityOrState(deliveryCity, deliveryState);

    /* ================= ACTIVE RATE CARDS ================= */
    const rateCards = (plan.B2BRateCard || []).filter(
      (rc) => rc.status?.toLowerCase() === "active"
    );

    if (!rateCards.length) {
      return res.json({
        success: true,
        zone: { fromZone, toZone },
        rates: [],
      });
    }

    /* ================= MOCK ORDER (FOR SERVICEABILITY CHECKS) ================= */
    const mockOrder = {
      pickupAddress: {
        city: pickupCity,
        state: pickupState,
        pinCode: pickupPincode,
      },
      receiverAddress: {
        city: deliveryCity,
        state: deliveryState,
        pinCode: deliveryPincode,
      },
      paymentDetails: {
        method: paymentType,
        amount: paymentValue,
      },
    };

    const isCOD = paymentType?.toUpperCase() === "COD";
    const orderValue = Number(paymentValue || 0);

    /* ================= RATE CALCULATION ================= */
    // Same serviceability dispatch (aggregator vs direct) and per-provider
    // caching as the real "Ship Now" flow — this was previously reimplemented
    // here with two bugs: comparing a string against an array of objects
    // (always false, so every rate card was silently skipped), and lowercasing
    // the match key when the real values preserve their original case. It also
    // had no branch for non-Shiprocket providers at all, so Delhivery rate
    // cards were being filtered out here too. Reusing checkB2BServiceability
    // fixes all of that by construction instead of patching around it.
    const serviceabilityCache = {};
    const results = [];

    for (const rc of rateCards) {
      const courier = await courierServiceB2B
        .findById(rc.courierService)
        .select("weight courier");
      if (!courier) continue;

      const provider = rc.courierProviderName;
      const cacheKey = provider?.toLowerCase() === "delhivery" ? rc.courierServiceName : provider;
      if (!serviceabilityCache[cacheKey]) {
        serviceabilityCache[cacheKey] = await checkB2BServiceability({
          provider,
          order: mockOrder,
          packages,
          courierServiceName: rc.courierServiceName,
        });
      }
      const serviceability = serviceabilityCache[cacheKey];

      let matchedService = null;
      if (serviceability.type === "aggregator") {
        const serviceName = courier.courier?.trim();
        matchedService = serviceability.couriers.find((s) => s.key === serviceName);
        if (!matchedService) continue;
      }
      if (serviceability.type === "direct" && !serviceability.serviceable) continue;

      const working = calculateB2BCargoRate({
        rateCard: rc,
        fromZone,
        toZone,
        packages,
        minWeight: courier.weight || 10,
        isCOD,
        orderValue,
        rovType,
        ...(matchedService ? { isODA: Boolean(matchedService.isODA) } : {}),
      });

      if (!working) continue;

      results.push({
        courierServiceName: rc.courierServiceName,
        provider,
        orderType:"B2B",
        mode_name: rc.courierServiceName?.toLowerCase()?.includes("air")
          ? "air"
          : "surface",
        working,
        tat: 3,
      });
    }

    /* ================= SORT BY PRICE ================= */
    results.sort((a, b) => a.working.grand_total - b.working.grand_total);

    /* ================= RESPONSE ================= */
    res.json({
      success: true,
      zone: { fromZone, toZone },
      pickup: {
        pincode: pickupPincode,
        city: pickupCity,
        state: pickupState,
      },
      delivery: {
        pincode: deliveryPincode,
        city: deliveryCity,
        state: deliveryState,
      },
      rates: results,
      
    });
  } catch (err) {
    console.error("B2B Rate Calc Error:", err);
    res.status(500).json({ error: err.message });
  }
};

module.exports = { CalculateB2BRateWithoutOrder };
