const RateCard = require("../models/rateCards.js");
const zoneManagementController = require("./zoneManagementController.js");
const getZone = zoneManagementController.getZone;
const Plan = require("../models/Plan.model.js");
const Couriers = require("../models/AllCourierSchema.js");
const {
  checkServiceabilityEcomExpress,
} = require("../AllCouriers/EcomExpress/Couriers/couriers.controllers.js");
const {
  checkPincodeServiceabilityDelhivery,
} = require("../AllCouriers/Delhivery/Courier/couriers.controller.js");
const {
  checkServiceabilityDTDC,
} = require("../AllCouriers/DTDC/Courier/couriers.controller.js");
const {
  checkSmartshipHubServiceability,
} = require("../AllCouriers/SmartShip/Couriers/couriers.controller.js");
const {
  checkAmazonServiceabilityWithoutOrder,
} = require("../AllCouriers/Amazon/Courier/couriers.controller.js");
const {
  checkServiceabilityShreeMaruti,
} = require("../AllCouriers/ShreeMaruti/Couriers/couriers.controller.js");
const {
  checkPincodeServiceability,
} = require("../checkPincodeServiceability/checkPincodeServiceability.controller.js");
const {
  checkZipypostServiceability,
} = require("../AllCouriers/Zipypost/Couriers/couriers.controller.js");
const { checkEkartServiceability } = require("../AllCouriers/Ekart/Couriers/couriers.controller.js");
const { checkServiceabilityBoxdLogistics } = require("../AllCouriers/BoxdLogistics/Courier/couriers.controller.js");
const { checkProshipServiceability } = require("../AllCouriers/Proship/Courier/couriers.controller.js");

const calculateRate = async (req, res) => {
  try {
    const id = req.user._id;
    const {
      pickUpPincode,
      deliveryPincode,
      applicableWeight,
      paymentType,
      declaredValue,
      dimensions,
    } = req.body;

    console.log(
      pickUpPincode,
      deliveryPincode,
      applicableWeight,
      paymentType,
      declaredValue,
      dimensions,
    );

    // Step 1: Get user’s plan
    const plan = await Plan.findOne({ userId: id });
    if (!plan) return res.status(404).json({ message: "Plan not found" });
    // ✅ Get active couriers from DB
    const activeCouriers = await Couriers.find({ status: "Enable" }).select(
      "courierName",
    );

    const activeCourierNames = activeCouriers.map((c) => c.courierName);
    // console.log("activeCourierNames:", activeCourierNames);

    const rateCards = plan.rateCard;
    const orderType = paymentType === "COD" ? "cod" : "prepaid";

    // Step 2: Get zone
    const { zone: currentZone } = await getZone(pickUpPincode, deliveryPincode);
    const chargedWeight = applicableWeight * 1000;
    const gst = 18;
    const ans = [];

    for (let rc of rateCards) {
      const provider = rc.courierProviderName;
      // console.log("provider:", provider);
      const mode = rc.mode;
      let serviceable = { success: false };

      // ✅ Skip if courier is disabled in DB
      const activeCouriersLower = activeCourierNames.map(c => c.toLowerCase());

      if (!activeCouriersLower.includes(provider.toLowerCase())) {
        console.log(`SKIPPED (not in activeCouriers): "${provider}"`);
        continue;
      }
      if (rc.status !== "Active") continue;

      // Only process supported providers
      if (
        ![
          "Delhivery",
          "Shree Maruti",
          "Dtdc",
          "Smartship",
          "Amazon Shipping",
          "EcomExpress",
          "Zipypost",
          "Ekart",
          "BoxdLogistics",
          "Proship"
        ].includes(provider)
      ) {
        continue;
      }

      // Step 3: Check local serviceability first
      // BoxdLogistics always uses its own API — skip local DB check
      if (provider === "BoxdLogistics") {
        const payload = {
          pickupPincode: pickUpPincode,
          shippingPincode: deliveryPincode,
          paymentMode: paymentType === "COD" ? "cod" : "prepaid",
          codAmount: paymentType === "COD" ? declaredValue : 0,
          weight: chargedWeight,
          length: dimensions?.length || 10,
          breadth: dimensions?.width || 10,
          height: dimensions?.height || 10,
        };
        const boxdResult = await checkServiceabilityBoxdLogistics(payload);
        // console.log("boxdlogistics serviceability:", boxdResult);

        let boxdServiceable = boxdResult && boxdResult.success !== false;
        if (boxdServiceable && Array.isArray(boxdResult.courier_ids)) {
          const sName = rc.courierServiceName.toLowerCase();
          if (sName.includes("surface")) {
            boxdServiceable = boxdResult.courier_ids.includes(4);
          } else if (sName.includes("air")) {
            boxdServiceable = boxdResult.courier_ids.includes(6);
          }
        }
        if (!boxdServiceable) continue;
        // ✅ Mark serviceable so the outer check below passes
        serviceable = { success: true };
      } else if (provider === "Proship") {
        const payload = {
          pickUpPincode: pickUpPincode,
          deliveryPincode: deliveryPincode,
        };
        const proshipResult = await checkProshipServiceability(payload);
        if (!proshipResult || proshipResult.success === false) continue;
        serviceable = { success: true };
      } else {

        let localServiceability = await checkPincodeServiceability(
          pickUpPincode,
          provider,
          deliveryPincode,
          paymentType,
        );

        // Step 4: Determine whether to call API fallback
        if (localServiceability.success === true) {
          serviceable = { success: true };
        } else if (
          ["courier_not_found", "error", "pincode_not_found"].includes(
            localServiceability.reason,
          )
        ) {
          // Local data missing → use API
          if (provider === "EcomExpress") {
            serviceable = await checkServiceabilityEcomExpress(
              pickUpPincode,
              deliveryPincode,
            );
          } else if (provider === "Shree Maruti") {
            const payload = {
              fromPincode: parseInt(pickUpPincode),
              toPincode: parseInt(deliveryPincode),
              isCodOrder: paymentType === "COD",
              deliveryMode: "SURFACE",
            };
            serviceable = await checkServiceabilityShreeMaruti(payload);
          } else if (provider === "Delhivery") {
            serviceable = await checkPincodeServiceabilityDelhivery(
              pickUpPincode,
              deliveryPincode,
              orderType,
            );
          } else if (provider === "Dtdc") {
            serviceable = await checkServiceabilityDTDC(
              pickUpPincode,
              deliveryPincode,
              paymentType,
            );
          } else if (provider === "Smartship") {
            const payload = {
              source_pincode: pickUpPincode,
              destination_pincode: deliveryPincode,
              order_weight: applicableWeight,
              order_value: declaredValue,
            };
            serviceable = await checkSmartshipHubServiceability(payload);
          } else if (provider === "Amazon Shipping") {
            serviceable = await checkAmazonServiceabilityWithoutOrder(
              pickUpPincode,
              deliveryPincode,
              applicableWeight,
              declaredValue,
              paymentType,
              dimensions,
            );
          } else if (provider === "Zipypost") {
            const payload = {
              source_pincode: pickUpPincode,
              destination_pincode: deliveryPincode,
              payment_type: paymentType,
              order_value: declaredValue,
              length: dimensions.length,
              width: dimensions.width,
              height: dimensions.height,
              order_weight: applicableWeight,
            };
            serviceable = await checkZipypostServiceability(payload);
            // console.log("service",serviceable)
          } else if (provider === "Ekart") {
            const payload = {
              pickUpPincode: pickUpPincode,
              deliveryPincode: deliveryPincode,
              paymentMethod: paymentType,
              codAmount: declaredValue,
            };
            serviceable = await checkEkartServiceability(payload);
          }
        } else {
          // Local says not serviceable → skip API
          continue;
        }

      } // end else (non-BoxdLogistics)

      let isServiceable = serviceable && serviceable.success !== false;

      if (!isServiceable) continue;

      // Step 5: Rate calculation
      let basicCharge = parseFloat(rc.weightPriceBasic[0][currentZone]);
      let additionalCharge = parseFloat(
        rc.weightPriceAdditional[0][currentZone],
      );

      const count = Math.ceil(
        (chargedWeight - rc.weightPriceBasic[0].weight) /
        rc.weightPriceAdditional[0].weight,
      );

      let finalCharge =
        rc.weightPriceBasic[0].weight >= chargedWeight
          ? basicCharge
          : basicCharge + additionalCharge * count;

      // Step 6: COD charges
      let cod = 0;
      if (paymentType === "COD") {
        const orderValue = Number(declaredValue) || 0;
        if (
          typeof rc.codCharge === "number" &&
          typeof rc.codPercent === "number"
        ) {
          cod = Math.max(rc.codCharge, orderValue * (rc.codPercent / 100));
        }
      }

      // Step 7: GST and total
      let gstAmount = Number(((finalCharge + cod) * gst) / 100).toFixed(2);
      let totalCharges = Math.round(finalCharge + cod + parseFloat(gstAmount));

      ans.push({
        courierServiceName: rc.courierServiceName,
        orderType: "B2C",
        provider,
        mode,
        cod,
        forward: {
          charges: finalCharge,
          gst: gstAmount,
          finalCharges: totalCharges,
        },
      });
    }

    return res.status(201).json(ans);
  } catch (error) {
    console.error("Error in Calculation:", error);
    res.status(500).json({ error: "Error in Calculation" });
  }
};

async function calculateRateForService(payload) {
  try {
    const {
      pickupPincode,
      deliveryPincode,
      length,
      breadth,
      height,
      weight,
      cod,
      valueInINR,
      userID,
      filteredServices,
      // rateCardType,
    } = payload;

    const result = await getZone(pickupPincode, deliveryPincode);

    const currentZone = result.zone;

    const ans = [];
    const l = parseFloat(length);
    const b = parseFloat(breadth);
    const h = parseFloat(height);
    const deadweight = parseFloat(weight) / 1000;
    const volumetricWeight = (l * b * h) / 5000;
    const chargedWeight = weight * 1000;

    // let codCharge = 0;
    const gstRate = 18;

    // const rateCards = [];
    const plan = await Plan.findOne({ userId: userID });
    let RateCards = plan.rateCard;
    // console.log("rate", RateCards);
    for (const rc of RateCards) {
      const basicChargeForward = parseFloat(
        rc.weightPriceBasic[0][currentZone],
      );
      const additionalChargeForward = parseFloat(
        rc.weightPriceAdditional[0][currentZone],
      );
      // console.log("basicChargeForward", basicChargeForward);
      // console.log("additionalChargeForward", additionalChargeForward);

      let totalForwardCharge;
      const count = Math.ceil(
        (chargedWeight - rc.weightPriceBasic[0].weight) /
        rc.weightPriceAdditional[0].weight,
      );
      // console.log("count", count);
      // console.log("chargedWeight", chargedWeight);
      if (rc.weightPriceBasic[0].weight >= chargedWeight) {
        totalForwardCharge = basicChargeForward;
        // console.log("totalForwardCharge111", totalForwardCharge);
      } else if (rc.weightPriceBasic[0].weight < chargedWeight) {
        totalForwardCharge =
          basicChargeForward + additionalChargeForward * count;
        // console.log("totalForwardCharge222", totalForwardCharge);
      }
      let codCharge = 0;
      if (cod === "Yes") {
        const orderValue = Number(valueInINR) || 0;
        if (
          typeof rc.codCharge === "number" &&
          typeof rc.codPercent === "number"
        ) {
          const calculatedCodCharge = Math.max(
            rc.codCharge,
            orderValue * (rc.codPercent / 100),
          );
          codCharge += calculatedCodCharge;
        } else {
          console.error("COD charge or percentage is not properly defined.");
        }
      }
      // console.log("totalForwardCharge", totalForwardCharge);
      const gstAmountForward = (
        (totalForwardCharge + codCharge) *
        (gstRate / 100)
      ).toFixed(2);
      const totalChargesForward = (
        totalForwardCharge +
        codCharge +
        (totalForwardCharge + codCharge) * (gstRate / 100)
      ).toFixed(2);
      // console.log("totalChargesForward",totalChargesForward)
      const allRates = {
        courierServiceName: rc.courierServiceName,
        cod: codCharge,
        forward: {
          charges: totalForwardCharge,
          gst: gstAmountForward,
          finalCharges: totalChargesForward,
        },
      };

      ans.push(allRates);
    }
    // console.log("0000000", ans);
    return ans;
  } catch (error) {
    console.error("Error in Calculation:", error);
    throw new Error("Error in Calculation");
  }
}

async function calculateRateForDispute(payload) {
  try {
    const {
      pickupPincode,
      deliveryPincode,
      weight, // extra weight in KG
      cod,
      valueInINR,
      userID,
      filteredServices,
    } = payload;

    const gstRate = 18;

    // Parallel fetch: zone + plan
    const [zoneResult, plan] = await Promise.all([
      getZone(pickupPincode, deliveryPincode),
      Plan.findOne({ userId: userID }),
    ]);

    if (!zoneResult || !zoneResult.zone) {
      throw new Error("Zone information could not be determined");
    }

    const currentZone = zoneResult.zone;

    if (!plan) {
      throw new Error("Rate card not found for user");
    }

    const RateCards = plan.rateCard || [];

    const services = RateCards.filter(
      (rate) => rate.courierServiceName === filteredServices,
    );

    if (services.length === 0) {
      throw new Error("No matching service found");
    }

    // Convert extra weight from KG to grams
    const extraWeightInGrams = Math.ceil(parseFloat(weight) * 1000); // e.g., 2.88 kg → 2880 g

    const ans = [];

    for (const rc of services) {
      const additionalRate = rc.weightPriceAdditional?.[0];
      if (
        !additionalRate ||
        !additionalRate.weight ||
        !additionalRate[currentZone]
      ) {
        console.warn(
          `Skipping service ${rc.courierServiceName} due to missing rate info`,
        );
        continue;
      }

      const additionalWeight = additionalRate.weight; // in grams
      const additionalCharge = parseFloat(additionalRate[currentZone]); // per slab

      const count = Math.ceil(extraWeightInGrams / additionalWeight);
      let totalForwardCharge = count * additionalCharge;
      totalForwardCharge = parseFloat(totalForwardCharge.toFixed(2));

      let codCharge = 0;
      if (cod === "Yes") {
        const orderValue = Number(valueInINR) || 0;
        if (
          typeof rc.codCharge === "number" &&
          typeof rc.codPercent === "number"
        ) {
          const calculatedCodCharge = Math.max(
            rc.codCharge,
            orderValue * (rc.codPercent / 100),
          );
          codCharge = parseFloat(calculatedCodCharge.toFixed(2));
        } else {
          console.warn("COD charge or percent not properly defined.");
        }
      }

      const gstAmountForward = parseFloat(
        ((totalForwardCharge + codCharge) * (gstRate / 100)).toFixed(2),
      );
      const totalChargesForward = parseFloat(
        (totalForwardCharge + codCharge + gstAmountForward).toFixed(2),
      );

      const allRates = {
        courierServiceName: rc.courierServiceName,
        cod: codCharge,
        forward: {
          charges: totalForwardCharge,
          gst: gstAmountForward,
          finalCharges: totalChargesForward,
        },
      };

      ans.push(allRates);
    }

    return ans;
  } catch (error) {
    console.error("Error in calculateRateForDispute:", error);
    throw new Error("Calculation failed");
  }
}

async function calculateRateForServiceBulk(payload) {
  try {
    const {
      pickupPincode,
      deliveryPincode,
      length,
      breadth,
      height,
      weight,
      cod,
      valueInINR,
      userID,
      filteredServices,
    } = payload;

    const { zone: currentZone } = await getZone(pickupPincode, deliveryPincode);

    const l = parseFloat(length);
    const b = parseFloat(breadth);
    const h = parseFloat(height);
    const chargedWeight = parseFloat(weight) * 1000; // weight in grams
    const gstRate = 18;

    const plan = await Plan.findOne({ userId: userID });
    if (!plan) throw new Error("Plan not found for user");

    // 🟢 Only find the matching courier from the plan rateCard
    const rc = plan.rateCard.find(
      (r) =>
        r.courierServiceName?.trim().toLowerCase() ===
        filteredServices.courierServiceName?.trim().toLowerCase(),
    );

    if (!rc) throw new Error("Selected courier not found in plan rate card");

    // Extract basic & additional weight/charges
    const basicWeight = parseFloat(rc.weightPriceBasic?.[0]?.weight || 0);
    const addWeight = parseFloat(rc.weightPriceAdditional?.[0]?.weight || 0);
    const basicCharge = parseFloat(
      rc.weightPriceBasic?.[0]?.[currentZone] || 0,
    );
    const addCharge = parseFloat(
      rc.weightPriceAdditional?.[0]?.[currentZone] || 0,
    );

    // 🧮 Calculate total forward charge
    let totalForwardCharge = 0;
    if (chargedWeight <= basicWeight) {
      totalForwardCharge = basicCharge;
    } else {
      const extraUnits = Math.ceil((chargedWeight - basicWeight) / addWeight);
      totalForwardCharge = basicCharge + addCharge * extraUnits;
    }

    // 🧾 COD charge calculation
    let codCharge = 0;
    if (cod === "Yes") {
      const orderValue = Number(valueInINR) || 0;
      const baseCodCharge = parseFloat(rc.codCharge) || 0;
      const codPercent = parseFloat(rc.codPercent) || 0;
      codCharge = Math.max(baseCodCharge, orderValue * (codPercent / 100));
    }

    // 🧮 GST + Final total
    const gstAmount = ((totalForwardCharge + codCharge) * gstRate) / 100;
    const totalFinalCharge = totalForwardCharge + codCharge + gstAmount;

    const rateDetails = {
      courierServiceName: rc.courierServiceName,
      cod: codCharge.toFixed(2),
      forward: {
        charges: totalForwardCharge.toFixed(2),
        gst: gstAmount.toFixed(2),
        finalCharges: totalFinalCharge.toFixed(2),
      },
    };

    return [rateDetails];
  } catch (error) {
    console.error("Error in calculateRateForServiceBulk:", error.message);
    throw new Error("Failed to calculate courier rate");
  }
}

module.exports = {
  calculateRate,
  calculateRateForService,
  calculateRateForServiceBulk,
  calculateRateForDispute,
};
