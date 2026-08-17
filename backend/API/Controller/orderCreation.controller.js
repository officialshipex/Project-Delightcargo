const Order = require("../../models/newOrder.model");
const { generateUniqueOrderIds } = require("../../utils/generateUniqueOrderId");
const Joi = require("joi");
const User = require("../../models/User.model");

// Your existing externalOrderSchema with the same validations
const externalOrderSchema = Joi.object({
  // Remove orderId from input schema since you'll generate it internally
  pickupAddress: Joi.object({
    contactName: Joi.string().required(),
    email: Joi.string().email().optional(),
    phoneNumber: Joi.string()
      .pattern(/^[0-9]{10}$/)
      .message("Phone number must be exactly 10 digits")
      .required(),
    address: Joi.string().required(),
    pinCode: Joi.string()
      .pattern(/^[0-9]{6}$/)
      .message("Pin code must be exactly 6 digits")
      .required(),
    city: Joi.string().required(),
    state: Joi.string().required(),
  }).required(),

  receiverAddress: Joi.object({
    contactName: Joi.string().required(),
    email: Joi.string().email().optional(),
    phoneNumber: Joi.string()
      .pattern(/^[0-9]{10}$/)
      .message("Phone number must be exactly 10 digits")
      .required(),
    address: Joi.string().required(),
    pinCode: Joi.string()
      .pattern(/^[0-9]{6}$/)
      .message("Pin code must be exactly 6 digits")
      .required(),
    city: Joi.string().required(),
    state: Joi.string().required(),
  }).required(),

  productDetails: Joi.array()
    .items(
      Joi.object({
        id: Joi.number().required(),
        quantity: Joi.number().required(),
        name: Joi.string().required(),
        sku: Joi.string().optional(),
        unitPrice: Joi.number().required(),
      })
    )
    .min(1)
    .required(),

  packageDetails: Joi.object({
    deadWeight: Joi.number().required(),
    applicableWeight: Joi.number().optional(),
    volumetricWeight: Joi.object({
      length: Joi.number().required(),
      width: Joi.number().required(),
      height: Joi.number().required(),
      calculatedWeight: Joi.number().optional(),
    }).required(),
  }).required(),

  paymentDetails: Joi.object({
    method: Joi.string().valid("COD", "Prepaid").required(),
    amount: Joi.number().when("method", {
      is: "Prepaid",
      then: Joi.required(),
      otherwise: Joi.optional(),
    }),
    totalDiscount: Joi.number().min(0).default(0).optional(),
    otherCharges: Joi.number().min(0).default(0).optional(),
  }).required(),

  shipmentId: Joi.number().optional(),
  // commodityId: Joi.number().optional(),
});

const orderCreationController = async (req, res) => {
  try {
    // Validate input - exclude orderId since you'll generate it
    const { error, value } = externalOrderSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: "Validation error",
        details: error.message,
      });
    }

    const {
      pickupAddress,
      receiverAddress,
      productDetails,
      packageDetails,
      paymentDetails,
      shipmentId
    } = value;

    const userId = req.user?._id || "external";

    const totalDiscount = paymentDetails.totalDiscount || 0;
    const otherCharges = paymentDetails.otherCharges || 0;

    // 💰 Calculate and validate total amount based on products
    const calculatedTotalAmount = productDetails.reduce((acc, item) => {
      return acc + (Number(item.unitPrice) * Number(item.quantity));
    }, 0);

    const expectedAmount = calculatedTotalAmount - totalDiscount + otherCharges;

    // Default to calculated expected total if amount is not provided
    if (paymentDetails.amount === undefined || paymentDetails.amount === null) {
      paymentDetails.amount = expectedAmount;
    } else if (paymentDetails.method === "COD") {
      if (Math.abs(paymentDetails.amount - expectedAmount) > 0.01) {
        return res.status(400).json({
          success: false,
          message: `Payment amount mismatch: declared ₹${paymentDetails.amount} but calculated total is ₹${expectedAmount} (Products total: ₹${calculatedTotalAmount}, total discount: ₹${totalDiscount}, other charges: ₹${otherCharges})`,
        });
      }
    }

    // 📦 Calculate volumetric weight and validate / enforce applicable weight
    const deadWeight = Number(packageDetails.deadWeight) || 0;
    const length = Number(packageDetails.volumetricWeight?.length) || 0;
    const width = Number(packageDetails.volumetricWeight?.width) || 0;
    const height = Number(packageDetails.volumetricWeight?.height) || 0;

    const calculatedVolumetricWeight = Number(((length * width * height) / 5000).toFixed(3));
    packageDetails.volumetricWeight.calculatedWeight = calculatedVolumetricWeight;

    const expectedApplicableWeight = Math.max(deadWeight, calculatedVolumetricWeight);

    if (packageDetails.applicableWeight !== undefined && packageDetails.applicableWeight !== null) {
      if (Math.abs(Number(packageDetails.applicableWeight) - expectedApplicableWeight) > 0.001) {
        return res.status(400).json({
          success: false,
          message: `Applicable weight mismatch: declared ${packageDetails.applicableWeight} kg but calculated applicable weight is ${expectedApplicableWeight} kg (higher of dead weight ${deadWeight} kg and volumetric weight ${calculatedVolumetricWeight} kg)`,
        });
      }
    } else {
      packageDetails.applicableWeight = expectedApplicableWeight;
    }


    // 🧩 Check if user exists and KYC is completed
    const currentUser = await User.findById(userId);
    if (!currentUser) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    if (!currentUser.kycDone) {
      return res.status(403).json({
        success: false,
        message: "KYC not completed. Please verify your KYC before creating an order.",
      });
    }

    // Generate a unique order ID
    const orderId = await generateUniqueOrderIds(1);

    const compositeOrderId = `${userId}-${orderId}`;

    // Check if compositeOrderId already exists (extra safety)
    const existingOrder = await Order.findOne({ compositeOrderId });
    if (existingOrder) {
      return res.status(409).json({
        success: false,
        message: `Duplicate order found with ID: ${orderId} for this user.`,
      });
    }

    // 🏗️ Create and save shipment/order
    const shipment = new Order({
      userId,
      orderId,
      pickupAddress,
      receiverAddress,
      productDetails,
      packageDetails,
      paymentDetails,
      compositeOrderId,
      status: "new",
      channel: "api",
      channelId: shipmentId,
      tracking: [
        {
          status: "new",
          StatusLocation: pickupAddress.city || "N/A",
          StatusDateTime: new Date(Date.now() + 5.5 * 60 * 60 * 1000),
          Instructions: "Order created successfully via API",
        },
      ],
    });

    await shipment.save();

    return res.status(201).json({
      success: true,
      message: "Order created successfully.",
      data: {
        orderId: shipment.orderId,
        clientOrderId: shipmentId,
        status: shipment.status,
      },
    });
  } catch (err) {
    console.error("Error creating order:", err);
    return res.status(500).json({
      success: false,
      message: "Internal Server Error",
    });
  }
};


module.exports = orderCreationController;
