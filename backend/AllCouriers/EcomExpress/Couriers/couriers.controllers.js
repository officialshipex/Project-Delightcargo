const axios = require("axios");
const FormData = require("form-data");
const user = require("../../../models/User.model");
const Order = require("../../../models/newOrder.model");
const Wallet = require("../../../models/wallet");
const WalletTransaction = require("../../../models/WalletTransaction.model");
const { fetchBulkWaybills } = require("../Authorize/saveCourierController");
const { assignPickupManifest } = require("../../../Orders/scheduledPickup.controller");
const checkServiceabilityEcomExpress = async (
  originPincode,
  destinationPincode
) => {
  // console.log("eocmcm")
  if (!originPincode || !destinationPincode) {
    return {
      success: false,
      error: "Both origin and destination pincodes are required.",
    };
  }

  const BASE_URL = process.env.ECOMEXPRESS_URL;
  const url = `${BASE_URL}/apiv3/pincode/`;

  try {
    // Check Origin Pincode
    const originFormData = new FormData();
    originFormData.append("username", process.env.ECOMEXPRESS_GMAIL);
    originFormData.append("password", process.env.ECOMEXPRESS_PASS);
    originFormData.append("pincode", originPincode);

    const originResponse = await axios.post(url, originFormData, {
      headers: originFormData.getHeaders(),
    });
    console.log("Origin Serviceability:", originResponse.data);

    if (!originResponse?.data?.length || !originResponse.data[0].active) {
      return {
        success: false,
        reason: "Origin pincode not serviceable",
        data: originResponse.data,
      };
    }

    // Check Destination Pincode
    const destinationFormData = new FormData();
    destinationFormData.append("username", process.env.ECOMEXPRESS_GMAIL);
    destinationFormData.append("password", process.env.ECOMEXPRESS_PASS);
    destinationFormData.append("pincode", destinationPincode);

    const destinationResponse = await axios.post(url, destinationFormData, {
      headers: destinationFormData.getHeaders(),
    });
    // console.log("Destination Serviceability:", destinationResponse.data);

    if (
      !destinationResponse?.data?.length ||
      !destinationResponse.data[0].active
    ) {
      return {
        success: false,
        reason: "Destination pincode not serviceable",
        data: destinationResponse.data,
      };
    }

    return { success: true, message: "Both pincodes are serviceable." };
  } catch (error) {
    console.error(
      "EcomExpress Serviceability Error:",
      error.response?.data || error.message
    );
    return { success: false, error: error.response?.data || error.message };
  }
};

const fetchAWB = async (req, res) => {
  const { count, type } = req.body;

  if (!count || !type) {
    return res.status(400).json({ error: "count, and type are required." });
  }

  const url =
    "https://clbeta.ecomexpress.in/services/shipment/products/v2/fetch_awb";
  const formData = new FormData();
  formData.append("username", process.env.ECOM_GMAIL);
  formData.append("password", process.env.ECOM_PASS);
  formData.append("count", count);
  formData.append("type", type);

  try {
    const response = await axios.post(url, formData, {
      headers: formData.getHeaders(),
    });
    res.status(200).json({ data: response.data });
  } catch (error) {
    if (error.response) {
      res
        .status(error.response.status || 500)
        .json({ error: error.response.data });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
};

const createManifest = async (req, res) => {
  try {
    const { id, provider, finalCharges, courierServiceName } = req.body;

    // Fetch order details
    const currentOrder = await Order.findById(id);
    if (!currentOrder) {
      return res
        .status(404)
        .json({ success: false, message: "Order not found" });
    }

    // Fetch user and wallet details
    const userRecord = await user.findById(currentOrder.userId);
    if (!userRecord) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    const currentWallet = await Wallet.findById(userRecord.Wallet).select("balance holdAmount creditLimit");

    // Generate AWB number (assuming you have a function to fetch it)
    const awbResponse = await fetchBulkWaybills(1);
    // console.log(awbResponse)
    if (!awbResponse || awbResponse.awbNumber.success !== "yes") {
      return res
        .status(400)
        .json({ success: false, message: "AWB number not generated" });
    }

    const awbNumber = awbResponse.awbNumber.awb[0]; // Extract first AWB number
    // console.log(awbNumber);
    const BASE_URL = process.env.ECOMEXPRESS_SERVICE_URL;
    // Ecom Express API URL
    const url = `${BASE_URL}/services/expp/manifest/v2/expplus/`;

    const applicableWeight = Number(
      currentOrder.packageDetails?.applicableWeight
    );
    const volumetricWeight =
      (currentOrder.packageDetails?.volumetricWeight?.length *
        currentOrder.packageDetails?.volumetricWeight?.width *
        currentOrder.packageDetails?.volumetricWeight?.height) /
      5000;
    console.log(applicableWeight, volumetricWeight);
    // Prepare JSON payload
    const jsonData = [
      {
        AWB_NUMBER: awbNumber,
        ORDER_NUMBER: currentOrder.orderId,
        PRODUCT:
          currentOrder.paymentDetails?.method === "Prepaid" ? "PPD" : "COD",

        CONSIGNEE: currentOrder.receiverAddress.contactName,
        CONSIGNEE_ADDRESS1: currentOrder.receiverAddress.address,
        DESTINATION_CITY: currentOrder.receiverAddress.city,
        STATE: currentOrder.receiverAddress.state,
        PINCODE: currentOrder.receiverAddress.pinCode,
        MOBILE: currentOrder.receiverAddress.phoneNumber,
        //   TELEPHONE: "1111111111",
        ITEM_DESCRIPTION:
          currentOrder.productDetails?.map((item) => item.name).join(", ") ||
          "No items",

        PIECES: currentOrder.productDetails?.length || 0,

        COLLECTABLE_VALUE:
          currentOrder.paymentDetails?.method === "Prepaid"
            ? 0
            : currentOrder.paymentDetails?.amount || 0,

        DECLARED_VALUE: finalCharges,
        ACTUAL_WEIGHT: applicableWeight,
        VOLUMETRIC_WEIGHT: volumetricWeight,
        LENGTH: currentOrder.packageDetails?.volumetricWeight?.length,
        BREADTH: currentOrder.packageDetails?.volumetricWeight?.width,
        HEIGHT: currentOrder.packageDetails?.volumetricWeight?.height,
        PICKUP_NAME: currentOrder.pickupAddress.contactName,
        PICKUP_ADDRESS_LINE1: currentOrder.pickupAddress.address,
        // PICKUP_ADDRESS_LINE2: "Test Pickup Address2",
        PICKUP_PINCODE: currentOrder.pickupAddress.pinCode,
        // PICKUP_PHONE: "2222222222",
        PICKUP_MOBILE: currentOrder.pickupAddress.phoneNumber,
        RETURN_NAME: currentOrder.pickupAddress.contactName,
        RETURN_ADDRESS_LINE1: currentOrder.pickupAddress.address,
        // RETURN_ADDRESS_LINE2: "Test Return Address2",
        RETURN_PINCODE: currentOrder.pickupAddress.pinCode,
        // RETURN_PHONE: "2222222222",
        RETURN_MOBILE: currentOrder.pickupAddress.phoneNumber,
      },
    ];

    // Create FormData
    const formData = new FormData();
    formData.append("username", process.env.ECOMEXPRESS_GMAIL);
    formData.append("password", process.env.ECOMEXPRESS_PASS);
    formData.append("json_input", JSON.stringify(jsonData));

    // Send request

    let response;
    if (currentWallet.balance >= finalCharges) {
      response = await axios.post(url, formData, {
        headers: { ...formData.getHeaders() },
      });
      console.log("Response Data:", response.data);
    } else {
      return res.status(401).json({ success: false, message: "Low Balance" });
    }

    if (response.data?.shipments[0]?.success) {
      const result = response.data?.shipments[0];
      // console.log(result);
      currentOrder.status = "Ready To Ship";
      currentOrder.cancelledAtStage = null;
      currentOrder.awb_number = result.awb;
      currentOrder.shipment_id = `${result.order_number}`;
      currentOrder.provider = provider;
      currentOrder.totalFreightCharges = finalCharges;
      currentOrder.shipmentCreatedAt = new Date();
      currentOrder.courierServiceName = courierServiceName;
      //   currentOrder.service_details = selectedServiceDetails._id;
      //   currentOrder.freightCharges =
      //     req.body.finalCharges === "N/A" ? 0 : parseInt(req.body.finalCharges);
      //   currentOrder.tracking = [];
      //   currentOrder.tracking.push({
      //     stage: "Order Booked",
      //   });
      await currentOrder.save();

      // ── Auto-assign pickup manifest ──
      try {
        await assignPickupManifest(currentOrder);
      } catch (pErr) {
        console.error("[Pickup] assignPickupManifest failed:", pErr.message);
      }
      let balanceToBeDeducted =
        finalCharges === "N/A" ? 0 : parseInt(finalCharges);
      //   let currentBalance = currentWallet.balance - balanceToBeDeducted;
      await currentWallet.updateOne({
        $inc: { balance: -balanceToBeDeducted },
      });

      // 🔁 Dual-write: mirror to WalletTransaction for future migration
      await WalletTransaction.create({
        walletId: currentWallet._id,
        channelOrderId: currentOrder.orderId || null,
        category: "debit",
        amount: balanceToBeDeducted,
        balanceAfterTransaction: currentWallet.balance - balanceToBeDeducted,
        date: new Date(),
        awb_number: result.awb || "",
        description: "Freight Charges Applied"
      });

      return res.status(201).json({
        message: "Shipment Created Succesfully",
        data: {
          orderId: currentOrder.orderId,
          provider: provider,
          waybill: result.awb,
        },
      });
    } else {
      return res.status(400).json({
        error: "Error creating shipment",
        message: response.data.shipments[0].reason,
      });
    }
  } catch (error) {
    console.error(
      "Error:",
      error.response ? error.response.data : error.message
    );
    return res.status(500).json({
      success: false,
      error: error.response ? error.response.data : error.message,
    });
  }
};

const getPincodes = async (req, res) => {
  const url = "https://clbeta.ecomexpress.in/apiv2/pincodes/";
  const formData = new FormData();
  formData.append("username", process.env.ECOM_GMAIL);
  formData.append("password", process.env.ECOM_PASS);

  try {
    const response = await axios.post(url, formData, {
      headers: formData.getHeaders(),
    });
    res.status(200).json({ data: response.data });
  } catch (error) {
    if (error.response) {
      res
        .status(error.response.status || 500)
        .json({ error: error.response.data });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
};

const getPincodeDetails = async (req, res) => {
  const { pincode } = req.body;

  if (!pincode) {
    return res.status(400).json({ error: "pincode are required." });
  }

  const url = "https://clbeta.ecomexpress.in/apiv3/pincode/";
  const formData = new FormData();
  formData.append("username", process.env.ECOM_GMAIL);
  formData.append("password", process.env.ECOM_PASS);
  formData.append("pincode", pincode);

  try {
    const response = await axios.post(url, formData, {
      headers: formData.getHeaders(),
    });
    res.status(200).json({ data: response.data });
  } catch (error) {
    if (error.response) {
      res
        .status(error.response.status || 500)
        .json({ error: error.response.data });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
};

// FORWARD JOURNEY
const createManifestAWBforward = async (req, res) => {
  const { jsonInput } = req.body;

  if (!jsonInput) {
    return res.status(400).json({ error: "json_input are required." });
  }

  const url = "https://clbeta.ecomexpress.in/apiv2/manifest_awb/";
  const formData = new FormData();
  formData.append("username", process.env.ECOM_GMAIL);
  formData.append("password", process.env.ECOM_PASS);
  formData.append("json_input", JSON.stringify(jsonInput));

  try {
    const response = await axios.post(url, formData, {
      headers: formData.getHeaders(),
    });
    console.log("reeee", response);
    res.status(200).json({ data: response.data });
  } catch (error) {
    console.log("errr", error);
    if (error.response) {
      res
        .status(error.response.status || 500)
        .json({ error: error.response.data });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
};

const cancelShipmentforward = async (awbs) => {
  console.log("awbbb", awbs);

  if (!awbs || typeof awbs !== "string" || awbs.trim() === "") {
    throw new Error("Invalid AWB number."); // Throw an error instead of using res
  }

  // Check if order is already cancelled
  const isCancelled = await Order.findOne({
    awb_number: awbs,
    status: "Cancelled",
  });

  if (isCancelled) {
    console.log("Order is already cancelled");
    return {
      error: "Order is already cancelled",
      code: 400,
    };
  }

  const BASE_URL = process.env.ECOMEXPRESS_URL;
  const url = `${BASE_URL}/apiv2/cancel_awb/`;

  if (!process.env.ECOMEXPRESS_GMAIL || !process.env.ECOMEXPRESS_PASS) {
    console.log("Missing API credentials"); // Throw error instead of using res
  }

  const formData = new FormData();
  formData.append("username", process.env.ECOMEXPRESS_GMAIL);
  formData.append("password", process.env.ECOMEXPRESS_PASS);
  formData.append("awbs", awbs);

  try {
    const response = await axios.post(url, formData, {
      headers: {
        ...formData.getHeaders(), // Correct headers
      },
    });

    console.log("ressss", response.data);

    await Order.updateOne(
      { awb_number: awbs },
      { $set: { status: "Cancelled" } }
    );

    return response.data; // Return API response instead of using res
  } catch (error) {
    console.error("Error cancelling order:", error.message);

    if (error.response) {
      throw new Error(JSON.stringify(error.response.data)); // Throw error with API response
    } else {
      throw new Error(error.message);
    }
  }
};
// cancelShipmentforward("456000001774")

// const axios = require("axios");
const { parseStringPromise } = require("xml2js");

const shipmentTrackingforward = async (awb) => {
  if (!awb) {
    return { error: "AWB number is required.", status: 400 };
  }

  const BASE_URL = process.env.ECOMEXPRESS_TRACK;
  const username = process.env.ECOMEXPRESS_GMAIL;
  const password = process.env.ECOMEXPRESS_PASS;

  // Construct URL with query parameters
  const url = `${BASE_URL}/track_me/api/mawbd/?username=${username}&password=${password}&awb=${awb}`;

  try {
    const response = await axios.get(url, {
      headers: { "x-webhook-version": "2.0" },
    });

    // Convert XML response to JSON
    const jsonResponse = await parseStringPromise(response.data, {
      explicitArray: false,
      mergeAttrs: true,
    });

    // Extract the field array
    const fields = jsonResponse["ecomexpress-objects"].object.field;
    // console.log("fields",fields)
    // Convert field array into an object with key-value pairs
    const structuredData = {};
    fields.forEach((item) => {
      structuredData[item.name] = item._ || null;
    });
    const refAWB = structuredData["ref_awb"];
    console.log("RTO AWB Number (ref_awb):", refAWB);
    // console.log("Final Parsed Response:", structuredData);
    return { success: true, data: structuredData, rto_awb: refAWB, status: 200 };
  } catch (error) {
    // console.error("Tracking API Error:", error.response?.data || error.message);

    if (error.response) {
      return {
        success: false,
        error: error.response.data,
        status: error.response.status || 500,
      };
    } else {
      return { success: false, error: error.message, status: 500 };
    }
  }
};


// REVERSE JOURNEY
const manifestAwbRev = async (req, res) => {
  const { json_input } = req.body;

  if (!json_input) {
    return res.status(400).json({ error: "json_input is required." });
  }

  const url = "https://clbeta.ecomexpress.in/apiv2/manifest_awb_rev_v2/";
  const formData = new FormData();
  formData.append("username", process.env.ECOM_GMAIL);
  formData.append("password", process.env.ECOM_PASS);
  formData.append("json_input", JSON.stringify(json_input));

  try {
    const response = await axios.post(url, formData, {
      headers: formData.getHeaders(),
    });
    res.status(200).json({ data: response.data });
  } catch (error) {
    if (error.response) {
      res
        .status(error.response.status || 500)
        .json({ error: error.response.data });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
};

const cancelShipmentRev = async (req, res) => {
  const { awbs } = req.body;

  if (!awbs) {
    return res.status(400).json({ error: "AWB number(s) are required." });
  }

  const url = "https://clbeta.ecomexpress.in/apiv2/cancel_awb/";
  const formData = new FormData();
  formData.append("username", process.env.ECOM_GMAIL);
  formData.append("password", process.env.ECOM_PASS);
  formData.append("awbs", awbs);

  try {
    const response = await axios.post(url, formData, {
      headers: formData.getHeaders(),
    });
    res.status(200).json({ data: response.data });
  } catch (error) {
    if (error.response) {
      res
        .status(error.response.status || 500)
        .json({ error: error.response.data });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
};

const shipmentTrackingRev = async (req, res) => {
  const { awb } = req.query;

  if (!awb) {
    return res.status(400).json({ error: "AWB number is required." });
  }

  const url = `https://clbeta.ecomexpress.in/track_me/api/mawbd/?username=${process.env.ECOM_GMAIL}&password=${process.env.ECOM_PASS}&awb=${awb}`;

  try {
    const response = await axios.get(url);
    res.status(200).json({ data: response.data });
  } catch (error) {
    if (error.response) {
      res
        .status(error.response.status || 500)
        .json({ error: error.response.data });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
};

module.exports = {
  checkServiceabilityEcomExpress,
  fetchAWB,
  createManifest,
  getPincodes,
  getPincodeDetails,
  createManifestAWBforward,
  cancelShipmentforward,
  shipmentTrackingforward,
  manifestAwbRev,
  cancelShipmentRev,
  shipmentTrackingRev,
};
