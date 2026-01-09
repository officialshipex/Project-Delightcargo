const ZoneMatrix = require("../../models/zoneMatrix.model");
const Plan = require("../../models/plan.model");
const courierServiceB2B = require("../../models/courierService.model");
const { findByPincode } = require("../../pincodeLoader");
const {
  getCargoServiceableCouriers,
} = require("../Couriers/AllCouriers/ShipRocket/Courier/couriers.controller");

const {
  getZoneByCityOrState,
  calculateB2BCargoRate,
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

    /* ================= MOCK ORDER (FOR SHIPROCKET CHECK) ================= */
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

    const serviceableCouriers = await getCargoServiceableCouriers({
      order: mockOrder,
      packages,
    });
    // console.log("Serviceable Couriers:", serviceableCouriers);

    /* ================= RATE CALCULATION ================= */
    const results = [];

    for (const rc of rateCards) {
      const courier = await courierServiceB2B
        .findById(rc.courierService)
        .select("weight courier");

      const serviceName = courier?.courier?.toLowerCase()?.trim();
    //   console.log("Evaluating Courier Service:", serviceName);
      if (!serviceableCouriers.includes(serviceName)) continue;

      const working = calculateB2BCargoRate({
        rateCard: rc,
        fromZone,
        toZone,
        packages,
        minWeight: courier?.weight || 10,
        isCOD: paymentType?.toUpperCase() === "COD",
        orderValue: Number(paymentValue || 0),
        rovType,
      });

      if (!working) continue;

      results.push({
        courierServiceName: rc.courierServiceName,
        provider: rc.courierProviderName,
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
