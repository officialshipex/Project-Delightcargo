const express = require("express");
const axios = require("axios");
const User = require("../../../models/User.model");
require("dotenv").config();
const Order = require("../../../models/newOrder.model");
const Wallet = require("../../../models/wallet");
const { getDTDCAuthToken } = require("../Authorize/saveCourierContoller");
const { getZone } = require("../../../Rate/zoneManagementController");
const commodityOptions = require("../../../config/commodityOptions");
const {
  markWooOrderAsShipped,
} = require("../../../Channels/WooCommerce/woocommerce.controller");
// const router = express.Router();

// DTDC API Configuration from environment variables
const DTDC_API_URL = process.env.DTDC_API_URL;
const API_KEY = process.env.DTDC_API_KEY;
const X_ACCESS_TOKEN = process.env.DTDC_X_ACCESS_TOKEN;

// Create a new shipment
const createOrder = async (req, res) => {
  try {
    console.log("API Key:", API_KEY);
    console.log("Access Token:", X_ACCESS_TOKEN);

    const {
      id,
      provider,
      finalCharges,
      courierServiceName,
      courier,
      estimatedDeliveryDate,
    } = req.body;
    console.log(id, provider, finalCharges, courierServiceName, courier);
    if (!courier) {
      return res.status(400).json({
        success: false,
        message: "service_type_id missing please refresh your page",
      });
    }
    // Fetch order, user, and wallet details
    const currentOrder = await Order.findById(id);
    if (!currentOrder) {
      return res
        .status(404)
        .json({ success: false, message: "Order not found" });
    }
    const zone = await getZone(
      currentOrder.pickupAddress.pinCode,
      currentOrder.receiverAddress.pinCode
      // res
    );
    console.log("zone", zone);
    if (!zone) {
      return res.status(400).json({ message: "Pincode not serviceable" });
    }
    const user = await User.findById(currentOrder.userId);
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    const currentWallet = await Wallet.findById(user.Wallet);
    if (!currentWallet) {
      return res
        .status(404)
        .json({ success: false, message: "Wallet not found" });
    }
    const productNames = currentOrder.productDetails
      .map((product) => product.name)
      .join(", ");

    // Detect commodity_id based on product name
    const lowerCaseProductNames = productNames.toLowerCase();
    let commodityId = "Others";
    for (const option of commodityOptions) {
      if (lowerCaseProductNames.includes(option.name.toLowerCase())) {
        commodityId = option.id;
        break;
      }
    }

    // Construct shipment payload
    const codCollectionMode =
      currentOrder.paymentDetails.method === "COD" ? "cash" : null;
    const codAmount =
      currentOrder.paymentDetails.method === "COD"
        ? currentOrder.paymentDetails.amount
        : 0;

    const shipmentData = {
      consignments: [
        {
          customer_code: "GL9711",
          service_type_id: courier,
          load_type: "NON-DOCUMENT",
          description: productNames,
          dimension_unit: "cm",
          length: currentOrder.packageDetails.volumetricWeight.length,
          width: currentOrder.packageDetails.volumetricWeight.width,
          height: currentOrder.packageDetails.volumetricWeight.height,
          weight_unit: "kg",
          weight: currentOrder.packageDetails.applicableWeight,
          declared_value: currentOrder.paymentDetails.amount,
          num_pieces: currentOrder.productDetails.length,

          origin_details: {
            name: currentOrder.pickupAddress.contactName,
            phone: currentOrder.pickupAddress.phoneNumber,
            address_line_1: currentOrder.pickupAddress.address,
            pincode: currentOrder.pickupAddress.pinCode,
            city: currentOrder.pickupAddress.city,
            state: currentOrder.pickupAddress.state,
          },

          destination_details: {
            name: currentOrder.receiverAddress.contactName,
            phone: currentOrder.receiverAddress.phoneNumber,
            address_line_1: currentOrder.receiverAddress.address,
            pincode: currentOrder.receiverAddress.pinCode,
            city: currentOrder.receiverAddress.city,
            state: currentOrder.receiverAddress.state,
          },

          customer_reference_number: currentOrder.orderId,

          // Ensure COD mode is correctly set
          cod_collection_mode: codCollectionMode,
          cod_amount: codAmount,

          ...(courierServiceName === "Dtdc Air" && {
            commodity_id: commodityId,
          }),
          reference_number: "",
        },
      ],
    };
    console.log(
      "consignments",
      shipmentData,
      shipmentData.consignments[0].origin_details,
      shipmentData.consignments[0].destination_details
    );

    // API call to DTDC
    let response;
    const walletHoldAmount = currentWallet?.holdAmount || 0;
    const effectiveBalance = currentWallet.balance - walletHoldAmount;
    if (currentWallet.balance >= finalCharges) {
      response = await axios.post(
        `${DTDC_API_URL}/customer/integration/consignment/softdata`,
        shipmentData,
        {
          headers: {
            "Content-Type": "application/json",
            "api-key": API_KEY,
            Authorization: `Bearer ${X_ACCESS_TOKEN}`,
          },
        }
      );
      console.log("dtdc response", response.data);
    } else {
      return res.status(400).json({ success: false, message: "Low Balance" });
    }
    if (response?.data?.data[0]?.success) {
      const result = response.data.data[0];
      currentOrder.status = "Booked";
      currentOrder.cancelledAtStage = null;
      currentOrder.awb_number = result.reference_number;
      currentOrder.shipment_id = `${result.customer_reference_number}`;
      currentOrder.provider = provider;
      currentOrder.totalFreightCharges =
        finalCharges === "N/A" ? 0 : parseInt(finalCharges);
      currentOrder.courierServiceName = courierServiceName;
      currentOrder.shipmentCreatedAt = new Date();
      currentOrder.zone = zone.zone;
      currentOrder.estimatedDeliveryDate = estimatedDeliveryDate || "";
      currentOrder.tracking.push({
        status: "Booked",
        StatusLocation: currentOrder.pickupAddress?.city || "N/A",
        StatusDateTime: new Date(),
        Instructions: "Order booked successfully",
      });
      let savedOrder = await currentOrder.save();
      let balanceToBeDeducted =
        finalCharges === "N/A" ? 0 : parseInt(finalCharges);
      // console.log("sjakjska",balanceToBeDeducted)
      await Wallet.findOneAndUpdate(
        { _id: user.Wallet, balance: { $gte: balanceToBeDeducted } },
        {
          $inc: { balance: -balanceToBeDeducted },
          $push: {
            transactions: {
              channelOrderId: currentOrder.orderId || null, // Include if available
              category: "debit",
              amount: balanceToBeDeducted, // Fixing incorrect reference
              balanceAfterTransaction:
                currentWallet.balance - balanceToBeDeducted,
              date: new Date(),
              awb_number: result.reference_number || "", // Ensuring it follows the schema
              description: `Freight Charges Applied`,
            },
          },
        }
      );
      // if (currentOrder.channel?.toLowerCase() === "woocommerce") {
      //   await markWooOrderAsSihpped(
      //     currentOrder.storeUrl,
      //     currentOrder.channelId,
      //     currentOrder.awb_number,
      //     currentOrder.provider
      //   );
      // }
    } else {
      console.log("ererer", response.data);
      return res.status(400).json({ message: response.data.data[0].message });
    }

    console.log(response.data.data);

    return res.status(200).json({
      message: "Shipment Created Successfully",
      success: true,
      data: response.data,
    });
  } catch (error) {
    console.error("Error creating shipment:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to create shipment",
      error: error.response?.data || error.message,
    });
  }
};

// DTDC API Configuration from environment variables
const DTDC_CANCEL_API_URL = `${DTDC_API_URL}/customer/integration/consignment/cancel`;

// Cancel a shipment
const cancelOrderDTDC = async (AWBNo) => {
  try {
    // Validate inputs
    if (!AWBNo || typeof AWBNo !== "string" || AWBNo.trim() === "") {
      return {
        success: false,
        message: "AWBNo is required and should be a non-empty string.",
      };
    }

    const isCancelled = await Order.findOne({
      awb_number: AWBNo,
      status: "Cancelled",
    });

    if (isCancelled) {
      console.log("Order is already cancelled");
      return {
        error: "Order is already cancelled",
        code: 400,
      };
    }

    const customerCode = "GL9711"; // Hardcoded customer code

    const requestData = { AWBNo: [AWBNo], customerCode }; // Convert AWBNo string to an array
    console.log("Cancel Order Request Data:", requestData);

    // API Call with Proper Authorization Header
    const response = await axios.post(DTDC_CANCEL_API_URL, requestData, {
      headers: {
        "Content-Type": "application/json",
        "api-key": API_KEY,
      },
    });

    await Order.updateOne(
      { awb_number: AWBNo },
      { $set: { status: "Cancelled" } }
    );

    console.log("DTDC Cancel Response:", response.data);
    if (response?.data?.success) {
      return {
        data: response.data,
        code: 201,
      };
    } else {
      return {
        error: "Error in shipment cancellation",
        details: response.data,
        code: 400,
      };
    }
  } catch (error) {
    console.error(
      "Error canceling shipment:",
      error.response?.data || error.message
    );
    return {
      success: false,
      message: "Failed to cancel shipment",
      error: error.response?.data || error.message,
    };
  }
};
// cancelOrderDTDC("I75009163")

// DTDC Tracking API Config
const DTDC_TRACKING_API_URL = `https://blktracksvc.dtdc.com/dtdc-api/rest/JSONCnTrk/getTrackDetails`;

// Track Order Controller
const trackOrderDTDC = async (AWBNo) => {
  const access_key = await getDTDCAuthToken();
  // console.log(access_key)
  try {
    const requestData = {
      trkType: "cnno",
      strcnno: AWBNo,
      addtnlDtl: "Y",
    };

    const response = await axios.post(DTDC_TRACKING_API_URL, requestData, {
      headers: {
        "Content-Type": "application/json",
        "x-access-token": access_key,
      },
    });
    // console.log(response.data)
    return { success: true, data: response.data };
  } catch (error) {
    // console.error(
    //   "Error tracking shipment:",
    //   error.response?.data || error.message
    // );
    return {
      success: false,
      error: error.response.message,
      status: 500,
    };
  }
};

const checkServiceabilityDTDC = async (originPincode, destinationPincode) => {
  try {
    if (!originPincode || !destinationPincode) {
      return {
        success: false,
        error: "Both origin and destination pincodes are required.",
      };
    }

    // API Request Body
    const requestBody = {
      orgPincode: originPincode,
      desPincode: destinationPincode,
    };

    // console.log("Request Body:", requestBody);

    // Make API Call
    const response = await axios.post(
      "http://smarttrack.ctbsplus.dtdc.com/ratecalapi/PincodeApiCall",
      requestBody,
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    // console.log("dtdc service",response.data)

    const zipCodeResponse = response.data.ZIPCODE_RESP || [];
    // console.log("DTDC Response:", response.data);

    if (zipCodeResponse.length === 0) {
      return { success: false }; // No data returned
    }

    // Filter responses for origin and destination
    const originResponses = zipCodeResponse.filter(
      (resp) => resp.ORGPIN === originPincode
    );
    const destinationResponses = zipCodeResponse.filter(
      (resp) => resp.DESTPIN === destinationPincode
    );

    // Ensure every response for origin and destination is SUCCESS and SERVFLAG === "Y"
    const isOriginServiceable =
      originResponses.length > 0 &&
      originResponses.every(
        (resp) => resp.MESSAGE === "SUCCESS" && resp.SERVFLAG === "Y"
      );
    const isDestinationServiceable =
      destinationResponses.length > 0 &&
      destinationResponses.every(
        (resp) => resp.MESSAGE === "SUCCESS" && resp.SERVFLAG === "Y"
      );

    // console.log("isOrigin:", isOriginServiceable);
    // console.log("isDestination:", isDestinationServiceable);

    // If both origin and destination are fully serviceable, return true
    return { success: isOriginServiceable && isDestinationServiceable };
  } catch (error) {
    // console.error("Error checking serviceability:", error.message);
    return { success: false };
  }
};

module.exports = {
  createOrder,
  cancelOrderDTDC,
  trackOrderDTDC,
  checkServiceabilityDTDC,
};
