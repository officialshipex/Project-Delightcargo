const Services = require("../models/CourierService.Schema");
const Courier = require("../models/AllCourierSchema");
const Order = require("../models/newOrder.model");
const plan = require("../models/Plan.model");
const User = require("../models/User.model");
const EDDMap = require("../models/EDDMap.model");
const { checkServiceabilityAll } = require("./shipment.controller");
const Wallet = require("../models/wallet");
const { AutoShip } = require("./AutoShipB2c.controller");
const { getZone } = require("../Rate/zoneManagementController");
const {
  calculateRateForService,
  calculateRateForServiceBulk,
} = require("../Rate/calculateRateController");

const {
  createShipmentFunctionDelhivery,
} = require("../AllCouriers/Delhivery/Courier/bulkShipment.controller");
const {
  createShipmentFunctionEcomExpress,
} = require("../AllCouriers/EcomExpress/Couriers/bulkShipment.controller");
const {
  createOrderDTDC,
} = require("../AllCouriers/DTDC/Courier/bulkShipment.controller");
const {
  createShipmentAmazon,
} = require("../AllCouriers/Amazon/Courier/bulkShipment.controller");
const {
  orderRegistrationOneStep,
} = require("../AllCouriers/SmartShip/Couriers/bulkShipment.controller");
const {
  createShipmentFunctionShreeMaruti,
} = require("../AllCouriers/ShreeMaruti/Couriers/bulkShipment.controller");
const {
  createOrderZipypost,
} = require("../AllCouriers/Zipypost/Couriers/bulkShipment.controller");
const updatePickup = async (req, res) => {
  try {
    // console.log(req.body)
    const { formData, setSelectedData } = req.body;
    console.log(formData, setSelectedData);

    if (!setSelectedData || !formData) {
      res
        .status(400)
        .json({ success: false, message: "id and pickup address not found" });
    }
    await Promise.all(
      setSelectedData.map(async (orderId) => {
        await Order.findByIdAndUpdate(orderId, {
          $set: { pickupAddress: formData },
        });
      })
    );
    res.status(200).json({ success: true, message: "Internal server error" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Internal server error" });
  }
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Atomically claim an order for processing
const claimOrder = async (orderId) => {
  return Order.findOneAndUpdate(
    { _id: orderId, status: "new" },
    { $set: { status: "processing", processingStartedAt: new Date() } },
    { new: true }
  );
};

const callProviderWithRetry = async (
  serviceDetails,
  order,
  wh,
  walletId,
  charges,
  maxRetries = 1,
  retryDelay = 1000
) => {
  // console.log("service",serviceDetails.provider)
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      let result;
      switch (serviceDetails.provider) {
        case "NimbusPost":
          result = await createShipmentFunctionNimbusPost(
            serviceDetails,
            order._id,
            wh,
            walletId,
            charges
          );
          break;
        case "Amazon Shipping":
          result = await createShipmentAmazon(
            serviceDetails,
            order._id,
            wh,
            walletId,
            charges
          );
          // console.log("result",result)
          break;
        case "Delhivery":
          result = await createShipmentFunctionDelhivery(
            serviceDetails,
            order._id,
            wh,
            walletId,
            charges
          );
          break;
        case "EcomExpress":
          result = await createShipmentFunctionEcomExpress(
            serviceDetails,
            order._id,
            wh,
            walletId,
            charges
          );
          break;
        case "Dtdc":
          result = await createOrderDTDC(
            serviceDetails,
            order._id,
            wh,
            walletId,
            charges
          );
          break;
        case "Smartship":
          result = await orderRegistrationOneStep(
            serviceDetails,
            order._id,
            wh,
            walletId,
            charges
          );
          break;
        case "Shree Maruti":
          result = await createShipmentFunctionShreeMaruti(
            serviceDetails,
            order._id,
            wh,
            walletId,
            charges
          );
          break;
        case "ZipyPost":
          result = await createOrderZipypost(
            serviceDetails,
            order._id,
            wh,
            walletId,
            charges
          );
          break;
        default:
          console.error(
            `No shipment function defined for ${serviceDetails.provider}`
          );
          return false;
      }

      if (result?.status === 200 || result?.status === 201 || result?.success) {
        return result;
      } else throw new Error("Provider call failed");
    } catch (error) {
      console.error(`Attempt ${attempt} failed for order ${order._id}:`, error);
      if (attempt < maxRetries) await delay(retryDelay);
    }
  }
  return false;
};

const shipBulkOrder = async (req, res) => {
  try {
    //   const { id, pincode, plan, isBulkShip } = req.body;
    const { selectedOrders, pinCode } = req.body;
    // console.log(pinCode)
    const userID = req.user._id;
    const plans = await plan.find({ userId: userID });
    //  console.log("9999999999,",plans)
    const servicesCursor = await Services.find({ status: "Enable" });

    const enabledServices = [];

    for await (const srvc of servicesCursor) {
      const provider = await Courier.findOne({
        courierProvider: srvc.provider,
      });
      // console.log("7777777777",provider)
      if (provider?.status === "Enable") {
        enabledServices.push(srvc);
      }
    }

    const availableServices = await Promise.all(
      selectedOrders.map(async (item) => {
        const serviceable = await Promise.all(
          enabledServices.map(async (svc) => {
            const result = await checkServiceabilityAll(svc, item, pinCode);
            return result.success ? svc : null;
          })
        );
        return serviceable.filter(Boolean);
      })
    );
    // console.log("avail",availableServices)
    // console.log("enabled",enabledServices)
    const flatServices = availableServices.flat();

    // Deduplicate by name
    const flattenedAvailableService = [];
    const serviceNames = new Set();

    for (const svc of flatServices) {
      const nameKey = svc.name.trim().toLowerCase();
      if (!serviceNames.has(nameKey)) {
        serviceNames.add(nameKey);
        flattenedAvailableService.push(svc);
      }
    }
    // console.log(flattenedAvailableService);

    const fplans = plans.flatMap((plan) =>
      plan.rateCard.map((item) => item.courierServiceName)
    );
    // console.log("Before filtering with fplans:");
    // flattenedAvailableService.forEach((svc) => console.log(`"${svc.name}"`));

    // console.log("fplans:");
    // fplans.forEach((plan) => console.log(`"${plan}"`));
    // console.log("fplans", fplans);

    const flattenedAvailableServices = flattenedAvailableService.filter(
      (item) =>
        fplans.some(
          (planName) =>
            planName
              .normalize("NFKC") // normalize unicode
              .replace(/\s+/g, " ") // replace multiple spaces with single
              .trim()
              .toLowerCase() ===
            item.name
              .normalize("NFKC")
              .replace(/\s+/g, " ")
              .trim()
              .toLowerCase()
        )
    );

    // console.log("flattend",flattenedAvailableServices); // Only matched services will be returned

    // console.log(flattenedAvailableServices);

    res.status(201).json({
      success: true,
      services: flattenedAvailableServices,
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch services",
      error: error.message,
    });
  }
};

const createBulkOrder = async (req, res) => {
  const { selectedOrders } = req.body;
  let successCount = 0;
  let failureCount = 0;
  // console.log("selected", selectedOrders);
  try {
    // const userId = req.user._id;
    // const user = await User.findById(userId);
    // if (!user) return res.status(404).json({ error: "User not found" });

    // const plans = await plan.findOne({ userId });
    // if (!plan) return res.status(404).json({ error: "User plan not found" });

    // const walletId = user.Wallet;
    const EDDRates = await EDDMap.find();
    const couriers = await Courier.find({ status: "Enable" });
    const courierServices = await Services.find({ status: "Enable" });

    const normalize = (str) => str?.toLowerCase().replace(/\s+/g, "").trim();

    // 🔁 Process each selected order
    for (const orderId of selectedOrders) {
      const claimedOrder = await claimOrder(orderId);
      if (!claimedOrder) {
        console.log(`Order ${orderId} is already processed. Skipping.`);
        continue;
      }

      try {
        const order = await Order.findById(orderId);
        if (!order) throw new Error("Order details not found");
        // ✅ Fetch user and plan based on each order’s userId
        const userId = order.userId;
        const user = await User.findById(userId);
        if (!user) throw new Error("User not found for order");

        const plans = await plan.findOne({ userId });
        if (!plans) throw new Error("User plan not found");

        const walletId = user.Wallet;
        const applicableWeight = order.packageDetails.applicableWeight;

        // ✅ Find eligible courier services based on plan.rateCard & weight
        // Step 1: Filter all slabs that are >= applicableWeight
        let eligibleCouriers = plans.rateCard
          .filter((rc) => rc.status === "Active") // Active only
          .filter((rc) => {
            const weightSlab = rc.weightPriceBasic?.[0]?.weight / 1000 || 0;
            return weightSlab >= applicableWeight;
          });

        // Step 2: Find the minimum (nearest) slab among them
        if (eligibleCouriers.length > 0) {
          const minSlab = Math.min(
            ...eligibleCouriers.map(
              (rc) => rc.weightPriceBasic?.[0]?.weight / 1000 || 0
            )
          );

          // Step 3: Keep only those couriers with that exact nearest slab
          eligibleCouriers = eligibleCouriers.filter(
            (rc) => rc.weightPriceBasic?.[0]?.weight / 1000 === minSlab
          );
        }

        // console.log("eligible courier", eligibleCouriers);
        if (eligibleCouriers.length === 0) {
          throw new Error("No courier available for this weight slab");
        }

        // ✅ Filter active + enabled couriers
        eligibleCouriers = eligibleCouriers.filter((rc) => {
          const service = courierServices.find(
            (cs) =>
              normalize(cs.name) === normalize(rc.courierServiceName) &&
              cs.status === "Enable"
          );
          const provider = couriers.find(
            (c) =>
              normalize(c.courierProvider) === normalize(rc.courierProviderName)
          );
          return service && provider?.status === "Enable";
        });

        // ✅ Sort based on plan.priorityType
        const zone = await getZone(
          order.pickupAddress.pinCode,
          order.receiverAddress.pinCode
        );

        let priorityType = plans.priorityType?.toLowerCase();
        if (!["cheapest", "fastest", "custom"].includes(priorityType)) {
          priorityType = "cheapest";
        }
        if (priorityType === "cheapest") {
          eligibleCouriers.sort((a, b) => {
            const costA = parseFloat(a.weightPriceBasic[0][zone.zone]) || 0;
            const costB = parseFloat(b.weightPriceBasic[0][zone.zone]) || 0;
            return costA - costB;
          });
        } else if (priorityType === "fastest") {
          eligibleCouriers.sort((a, b) => {
            const eddA = EDDRates.find(
              (e) =>
                normalize(e.serviceName) === normalize(a.courierServiceName)
            );
            const eddB = EDDRates.find(
              (e) =>
                normalize(e.serviceName) === normalize(b.courierServiceName)
            );
            const daysA =
              eddA?.zoneRates?.[zone.zone] ?? Number.MAX_SAFE_INTEGER;
            const daysB =
              eddB?.zoneRates?.[zone.zone] ?? Number.MAX_SAFE_INTEGER;
            return daysA - daysB;
          });
        } else if (priorityType === "custom") {
          const customOrder = plans.rateCard.map((r) =>
            r?.courierServiceName?.toLowerCase()
          );
          eligibleCouriers.sort((a, b) => {
            const indexA = customOrder.indexOf(
              a.courierServiceName?.toLowerCase()
            );
            const indexB = customOrder.indexOf(
              b.courierServiceName?.toLowerCase()
            );
            return indexA - indexB;
          });
        }

        // ✅ Try couriers sequentially
        let shipmentSuccess = false;
        for (const courier of eligibleCouriers) {
          try {
            const details = {
              pickupPincode: order.pickupAddress.pinCode,
              deliveryPincode: order.receiverAddress.pinCode,
              length: order.packageDetails.volumetricWeight.length,
              breadth: order.packageDetails.volumetricWeight.width,
              height: order.packageDetails.volumetricWeight.height,
              weight: applicableWeight,
              cod: order.paymentDetails.method === "COD" ? "Yes" : "No",
              valueInINR: order.paymentDetails.amount,
              userID: userId,
              filteredServices: courier,
            };

            const rates = await calculateRateForServiceBulk(details);
            // console.log("courier",courier)
            const charges = parseFloat(rates?.[0]?.forward?.finalCharges || 0);
            // ✅ Skip if charges invalid, NaN, or 0
            if (!charges || isNaN(charges) || charges <= 0) {
              console.warn(
                `⚠️ Skipping order ${orderId}: Invalid or zero charges for courier ${courier.courierServiceName}`
              );
              continue;
            }
            // console.log("charges", charges);

            const courierDetails = {
              provider: courier.courierProviderName,
              name: courier.courierServiceName,
            };
            const result = await callProviderWithRetry(
              courierDetails,
              order,
              order.pickupAddress,
              walletId,
              charges
            );

            if (result) {
              shipmentSuccess = true;
              successCount++;
              console.log(
                `✅ Order ${orderId} created with ${courier.courierServiceName}`
              );
              break;
            }
          } catch (err) {
            console.warn(
              `Courier ${courier.courierServiceName} failed for order ${orderId}: ${err.message}`
            );
            continue; // try next courier
          }
        }

        if (!shipmentSuccess) {
          failureCount++;
          await Order.findByIdAndUpdate(orderId, {
            $set: {
              status: "new",
              failureReason: "All couriers failed",
            },
          });
        }

        await delay(1000);
      } catch (error) {
        console.error(`Order ${orderId} processing error:`, error.message);
        await Order.findByIdAndUpdate(orderId, {
          $set: { status: "new", failureReason: error.message },
        });
        failureCount++;
      }
    }

    return res.status(201).json({
      success: true,
      message: `${successCount} orders created successfully & ${failureCount} failed.`,
      successCount,
      failureCount,
    });
  } catch (error) {
    console.error("Bulk order creation error:", error.message);
    return res.status(500).json({
      error: "Internal Server Error",
      message: error.message,
    });
  }
};

module.exports = {
  updatePickup,
  shipBulkOrder,
  createBulkOrder,
};
