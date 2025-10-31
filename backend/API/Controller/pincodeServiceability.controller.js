const Joi = require("joi");
const zoneManagementController = require("../../Rate/zoneManagementController");
const getZone = zoneManagementController.getZone;
const Plan = require("../../models/Plan.model");
const {
  checkServiceabilityEcomExpress,
} = require("../../AllCouriers/EcomExpress/Couriers/couriers.controllers.js");
const {
  checkPincodeServiceabilityDelhivery,
} = require("../../AllCouriers/Delhivery/Courier/couriers.controller.js");
const {
  checkServiceabilityDTDC,
} = require("../../AllCouriers/DTDC/Courier/couriers.controller.js");
const {
  checkSmartshipHubServiceability,
} = require("../../AllCouriers/SmartShip/Couriers/couriers.controller.js");
const {
  checkAmazonServiceability,
} = require("../../AllCouriers/Amazon/Courier/couriers.controller.js");
const {checkServiceabilityShreeMaruti} = require("../../AllCouriers/ShreeMaruti/Couriers/couriers.controller.js");

// Input Validation Schema
const serviceabilitySchema = Joi.object({
  pickUpPincode: Joi.string()
    .trim()
    .required()
    .pattern(/^\d{6}$/),
  deliveryPincode: Joi.string()
    .trim()
    .required()
    .pattern(/^\d{6}$/),
  applicableWeight: Joi.number().positive().max(100).required(),
  paymentType: Joi.string().valid("COD", "Prepaid").required(),
  declaredValue: Joi.number().positive().allow(0).required(),
});

const pincodeServiceability = async (req, res) => {
  // 1. Input Validation
  const { error, value: validated } = serviceabilitySchema.validate(req.body, {
    abortEarly: false,
  });
  if (error) {
    return res.status(400).json({
      status: "failure",
      message: "Invalid request data",
      errors: error.details.map((d) => {
        if (d.context.key.includes("Pincode")) {
          return "Pincode must be exactly 6 digits.";
        }
        return d.message;
      }),
    });
  }

  const {
    pickUpPincode,
    deliveryPincode,
    applicableWeight,
    paymentType,
    declaredValue,
  } = validated;

  try {
    // Providers in preferred order
    const providers = [
      {
        name: "EcomExpress",
        check: async () =>
          await checkServiceabilityEcomExpress(pickUpPincode, deliveryPincode),
      },
      {
        name: "Delhivery",
        check: async () => {
          const orderType =
            paymentType.toLowerCase() === "cod" ? "cod" : "prepaid";
          return await checkPincodeServiceabilityDelhivery(
            deliveryPincode,
            orderType
          );
        },
      },
      {
        name: "Dtdc",
        check: async () =>
          await checkServiceabilityDTDC(pickUpPincode, deliveryPincode),
      },
      {
        name: "Smartship",
        check: async () =>
          await checkSmartshipHubServiceability({
            source_pincode: pickUpPincode,
            destination_pincode: deliveryPincode,
            order_weight: applicableWeight,
            order_value: declaredValue,
          }),
      },
      {
        name: "Amazon Shipping",
        check: async () =>
          await checkAmazonServiceability({
            pickUpPincode,
            deliveryPincode,
            applicableWeight,
            declaredValue,
          }),
      },
      {
        name: "Shree Maruti",
        check: async () => {
          const payload = {
            fromPincode: parseInt(pickUpPincode),
            toPincode: parseInt(deliveryPincode),
            isCodOrder: paymentType === "COD" ? true : false,
            deliveryMode: "SURFACE",
          };
          return await checkServiceabilityShreeMaruti(payload);
        },
      },
      {
        name: "ZipyPost",
        check: async () => {
          const payload = {
            source_pincode: pickUpPincode,
            destination_pincode: deliveryPincode,
            payment_type: paymentType,
            order_weight: applicableWeight * 1000,
            length: 10,
            breadth: 10,
            height: 10,
            order_value: declaredValue,
          };
          return await checkServiceabilityZipyPost(payload);
        }
      }
    ];

    // Sequential check; stop at first serviceable
    for (const provider of providers) {
      const result = await provider.check();
      if (result && result.success === true) {
        return res.status(200).json({
          status: "success",
          message: `Service available for these pincodes.`,
          serviceable: true,
          pincodes: {
            pickup: pickUpPincode,
            delivery: deliveryPincode,
          },
        });
      }
    }

    // No serviceable provider found
    return res.status(200).json({
      status: "success",
      message: "No courier service available for these pincodes.",
      serviceable: false,
      pincodes: {
        pickup: pickUpPincode,
        delivery: deliveryPincode,
      },
    });
  } catch (err) {
    console.error("Error in Serviceability Check:", err);
    return res.status(500).json({
      status: "failure",
      message: "An unexpected error occurred during serviceability check.",
      error: err.message,
    });
  }
};

module.exports = pincodeServiceability;
