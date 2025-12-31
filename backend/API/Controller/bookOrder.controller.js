const Joi = require("joi");
const {
  calculateRateForService,
} = require("../../Rate/calculateRateController");
const Order = require("../../models/newOrder.model");
const Wallet = require("../../models/wallet");
const createAmazonShipment = require("../Courier/amazonShipmentCreation.controller");
const createDelhiveryShipment = require("../Courier/delhiveryShipmentCreation.controller");
const createDTDCShipment = require("../Courier/dtdcShipmentCreation.controller");
const createSmartshipShipment = require("../Courier/smartshipShipmentCreation.controller");
const CourierService = require("../../models/CourierService.Schema");
const User = require("../../models/User.model");
const mongoose = require("mongoose");
const createShreeMarutiShipment = require("../Courier/shreeMarutiShipmentCreation.controller");
const createZipypostShipment = require("../Courier/zipyPostShipmentCreation.controller");

// Provider mapping
const providerMap = {
  // "01": "EcomExpress",
  "02": "Delhivery",
  "03": "Dtdc",
  "04": "Smartship",
  "05": "Amazon Shipping",
  "06": "Shree Maruti",
  "07": "ZipyPost",
};

// Validation schema
const orderSchema = Joi.object({
  orderId: Joi.string().trim().required().messages({
    "string.empty": "Order ID is required",
  }),
  courierServiceName: Joi.string().trim().required().messages({
    "string.empty": "Courier Service Name is required",
  }),
  courierId: Joi.string().length(2).required().messages({
    "string.length": "Courier ID must be a 2-digit string",
    "string.empty": "Courier ID is required",
  }),
});

const bookOrder = async (req, res) => {
  const userId = req.user._id;

  // ✅ Validate request body
  const { error, value } = orderSchema.validate(req.body, {
    abortEarly: false,
  });
  if (error) {
    return res.status(400).json({
      status: "failure",
      message: "Invalid request data",
      errors: error.details.map((d) => d.message),
    });
  }

  const { orderId, courierServiceName, courierId } = value;
  const provider = providerMap[courierId] || null;
  console.log("value", value, provider);
  try {
    // ✅ Fetch order
    const order = await Order.findOne({ orderId });
    if (!order) {
      return res.status(404).json({
        status: "failure",
        message: `Order with ID ${orderId} not found.`,
      });
    }

    if (order.status !== "new") {
      return res.status(400).json({
        status: "failure",
        message: "Order must be in 'new' state to book shipment.",
      });
    }

    // ✅ Fetch user
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        status: "failure",
        message: "User not found.",
      });
    }

    if (!user.kycDone) {
      return res.status(403).json({
        status: "failure",
        message:
          "KYC not completed. Please verify your KYC before booking an order.",
      });
    }

    // ✅ Fetch wallet
    const wallet = await Wallet.findById(user.Wallet);
    if (!wallet) {
      return res.status(404).json({
        status: "failure",
        message: "Wallet not found for user.",
      });
    }

    // ✅ Prepare payload for rate calculation
    const payload = {
      pickupPincode: order.pickupAddress?.pinCode,
      deliveryPincode: order.receiverAddress?.pinCode,
      length: order.packageDetails?.volumetricWeight?.length,
      breadth: order.packageDetails?.volumetricWeight?.breadth,
      height: order.packageDetails?.volumetricWeight?.height,
      weight: order.packageDetails?.applicableWeight,
      cod: order.paymentDetails?.paymentType === "COD" ? "Yes" : "No",
      valueInINR: order.paymentDetails?.amount,
      userID: userId,
    };

    // ✅ Calculate rates
    const finalChargesArray = await calculateRateForService(payload);

    // ✅ Validate courier service
    const matchedChargeObj = finalChargesArray.find(
      (item) =>
        item.courierServiceName.toLowerCase() ===
        courierServiceName.toLowerCase()
    );

    if (!matchedChargeObj) {
      return res.status(400).json({
        status: "failure",
        message: `Courier service '${courierServiceName}' is invalid or not supported.`,
      });
    }

    const finalCharges = matchedChargeObj.forward?.finalCharges || null;
    if (!finalCharges) {
      return res.status(400).json({
        status: "failure",
        message: `Rate for courier service '${courierServiceName}' not available.`,
      });
    }

    // ✅ Check wallet balance
    const walletHoldAmount = wallet.holdAmount || 0;
    const effectiveBalance = wallet.balance - walletHoldAmount;

    if (effectiveBalance < finalCharges) {
      return res.status(400).json({
        status: "failure",
        message: "Insufficient wallet balance to create this shipment.",
      });
    }

    // ✅ Fetch courier service (for DTDC etc.)
    const courierService = await CourierService.findOne({
      name: { $regex: `^\\s*${courierServiceName.trim()}\\s*$`, $options: "i" },
      provider,
    });

    // console.log("courier", courierService);
    if (!courierService) {
      return res.status(400).json({
        status: "failure",
        message: `Courier service '${courierServiceName}' and courier ID '${courierId}' mismatch or not supported.`,
      });
    }

    if (!provider) {
      return res.status(400).json({
        status: "failure",
        message: `Courier ID '${courierId}' is invalid or not supported.`,
      });
    }

    // ✅ Create shipment by provider
    let shipmentResult;
    switch (provider) {
      case "Amazon Shipping":
        shipmentResult = await createAmazonShipment({
          id: order._id,
          provider,
          finalCharges,
          courierServiceName,
        });
        break;

      case "Delhivery":
        shipmentResult = await createDelhiveryShipment({
          id: order._id,
          provider,
          finalCharges,
          courierServiceName,
        });
        break;

      case "Dtdc":
        shipmentResult = await createDTDCShipment({
          id: order._id,
          provider,
          finalCharges,
          courierServiceName,
          courier: courierService?.courier,
        });
        break;

      case "Smartship":
        shipmentResult = await createSmartshipShipment({
          id: order._id,
          provider,
          finalCharges,
          courierServiceName,
        });
        break;
      case "Shree Maruti":
        shipmentResult = await createShreeMarutiShipment({
          id: order._id,
          provider,
          finalCharges,
          courierServiceName,
        });
        break;
      case "ZipyPost":
        shipmentResult = await createZipypostShipment({
          id: order._id,
          provider,
          finalCharges,
          courierServiceName,
        });
        break;

      case "EcomExpress":
        return res.status(400).json({
          status: "failure",
          message: "EcomExpress shipment creation not implemented yet.",
        });

      default:
        return res.status(400).json({
          status: "failure",
          message: `Courier ID '${courierId}' is mismatched or not supported.`,
        });
    }

    if (!shipmentResult?.success) {
      console.error("Shipment creation failed:", shipmentResult);
      return res.status(400).json({
        status: "failure",
        message: shipmentResult?.message || "Shipment creation failed.",
      });
    }

    // ✅ Final success response
    return res.status(200).json({
      status: "success",
      message: "Order booked and shipment created successfully.",
      data: {
        orderId,
        courierServiceName,
        courierId,
        awb_number: shipmentResult.awb_number || null,
        labelUrl: shipmentResult.labelUrl || null,
      },
    });
  } catch (err) {
    console.error("Error booking order:", err);
    return res.status(500).json({
      status: "failure",
      message: "Unexpected server error while booking order. Please try again.",
    });
  }
};

module.exports = bookOrder;
