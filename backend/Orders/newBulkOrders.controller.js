const Services = require("../models/CourierService.Schema");
const Courier = require("../models/AllCourierSchema");
const Order = require("../models/newOrder.model");
const plan = require("../models/Plan.model");
const User = require("../models/User.model");
const { checkServiceabilityAll } = require("./shipment.controller");
const Wallet = require("../models/wallet");
const { AutoShip } = require("./AutoShipB2c.controller");
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
            `No shipment function defined for ${serviceDetails.courierProviderName}`
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
  const { item, selectedOrders, wh, id, selectedServiceDetails } = req.body;
  let successCount = 0;
  let failureCount = 0;
  console.log("selected", selectedOrders, item, wh);
  try {
    const userId = req.user._id;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    const walletId = user.Wallet;

    const ordersToProcess =
      Array.isArray(selectedOrders) && selectedOrders.length > 0
        ? selectedOrders.map((o) => (typeof o === "object" ? o._id : o))
        : Array.isArray(id)
        ? id
        : id
        ? [id]
        : [];

    for (const orderId of ordersToProcess) {
      // const orderId = orderObj._id;
      // Atomically claim order
      const claimedOrder = await claimOrder(orderId);
      if (!claimedOrder) {
        console.log(`Order ${orderId} is already processed. Skipping.`);
        continue;
      }

      try {
        const orderDetails = await Order.findById(orderId);
        // console.log("orderdetails",orderDetails)
        if (!orderDetails) throw new Error("Order details not found");

        const details = {
          pickupPincode: `${wh.pinCode}`,
          deliveryPincode: `${orderDetails.receiverAddress.pinCode}`,
          length: orderDetails.packageDetails.volumetricWeight.length,
          breadth: orderDetails.packageDetails.volumetricWeight.width,
          height: orderDetails.packageDetails.volumetricWeight.height,
          weight: orderDetails.packageDetails.applicableWeight,
          cod: orderDetails.paymentDetails.method === "COD" ? "Yes" : "No",
          valueInINR: orderDetails.paymentDetails.amount,
          userID: userId,
          filteredServices: item,
        };
        // console.log("details",details)

        const rates = item
          ? await calculateRateForServiceBulk(details)
          : await calculateRateForService(details);
        // console.log("rates", rates);
        const charges = parseInt(rates[0]?.forward?.finalCharges);
        if (!charges) throw new Error("Invalid shipping charges");

        // Call provider (wallet deduction handled inside courier function)
        const result = await callProviderWithRetry(
          item ? item : selectedServiceDetails,
          orderDetails,
          wh,
          walletId,
          charges
        );

        if (!result) {
          await Order.findByIdAndUpdate(orderId, {
            $set: {
              status: "new",
              failureReason: "Provider shipment failed",
            },
          });
          failureCount++;
        } else {
          // await Order.findByIdAndUpdate(orderId, {
          //   $set: {
          //     status: "booked",
          //     awb: result?.awb || "",
          //     shipmentCreatedAt: new Date(),
          //   },
          // });
          successCount++;
        }

        await delay(1000); // delay between orders
      } catch (error) {
        console.error(`Order ${orderId} processing error:`, error.message);
        await Order.findByIdAndUpdate(orderId, {
          $set: { status: "new", failureReason: error.message },
        });
        failureCount++;
      }
    }

    return res.status(201).json({
      message: `${successCount} orders created successfully & ${failureCount} failed.`,
      successCount,
      failureCount,
      remainingOrdersCount:
        ordersToProcess.length - successCount - failureCount,
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
