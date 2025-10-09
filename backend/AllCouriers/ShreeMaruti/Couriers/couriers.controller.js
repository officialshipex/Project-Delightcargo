if (process.env.NODE_ENV != "production") {
  require("dotenv").config();
}
const axios = require("axios");
const { getToken } = require("../Authorize/shreeMaruti.controller");
const Courier = require("../../../models/courierSecond");
const Services = require("../../../models/CourierService.Schema");
const Order = require("../../../models/newOrder.model");
const { getUniqueId } = require("../../getUniqueId");
const Wallet = require("../../../models/wallet");
const user = require("../../../models/User.model");

const BASE_URL = process.env.SHREEMA_PRODUCTION_URL;

const getCourierList = async (req, res) => {
  try {
    const currCourier = await Courier.findOne({
      provider: "ShreeMaruti",
    }).populate("services");
    const servicesData = currCourier.services;

    const allServices = servicesData.map((element) => ({
      service: element.courierProviderServiceName,
      isAdded: true,
    }));

    return res.status(201).json(allServices);
  } catch (error) {
    res.status(500).json({
      error: "Failed to fetch courier list",
      details: error.response?.data || error.message,
    });
  }
};

const addService = async (req, res) => {
  try {
    const currCourier = await Courier.findOne({ provider: "ShreeMaruti" });

    const prevServices = new Set();
    const services = await Services.find({
      _id: { $in: currCourier.services },
    });

    services.forEach((service) => {
      prevServices.add(service.courierProviderServiceName);
    });

    const name = req.body.service;

    if (!prevServices.has(name)) {
      const newService = new Services({
        courierProviderServiceId: getUniqueId(),
        courierProviderServiceName: name,
        courierProviderName: "ShreeMaruti",
        createdName: req.body.name,
      });

      const S2 = await Courier.findOne({ provider: "ShreeMaruti" });
      S2.services.push(newService._id);

      await newService.save();
      await S2.save();

      // console.log(`New service saved: ${name}`);

      return res
        .status(201)
        .json({ message: `${name} has been successfully added` });
    }

    return res.status(400).json({ message: `${name} already exists` });
  } catch (error) {
    console.error(`Error adding service: ${error.message}`);
    res
      .status(500)
      .json({ message: "Internal Server Error", error: error.message });
  }
};

// Create Order
const createOrder = async (req, res) => {
  const API_URL = `${BASE_URL}/fulfillment/public/seller/order/ecomm/push-order`;
  const token = await getToken();

  // console.log("bodyyyyy", req.body);
  try {
    const { courierServiceName, id, provider, finalCharges,estimatedDeliveryDate } = req.body;
    const services = await Services.findOne({ name: courierServiceName });
    const currentOrder = await Order.findById(id);
    const users = await user.findById({ _id: currentOrder.userId });
    // console.log("currentOrder",currentOrder)
    const currentWallet = await Wallet.findById({ _id: users.Wallet });

    const lineItems = Array.from(
      { length: currentOrder.productDetails.length },
      (_, index) => {
        const item = currentOrder.productDetails[index];

        return {
          name: item.name,
          quantity: Number(item.quantity) || 0, // Ensure it's a number, default to 0 if invalid
          price: Number(item.unitPrice) * Number(item.quantity) || 0, // Ensure valid price
          unitPrice: Number(item.unitPrice) || 0, // Ensure valid unit price
          weight: currentOrder.packageDetails?.applicableWeight
            ? Math.max(
                Number(currentOrder.packageDetails.applicableWeight) * 1000,
                1
              )
            : 1,
          sku: item.sku || null,
        };
      }
    );

    let payment_type =
      currentOrder.paymentDetails.method === "COD" ? "COD" : "ONLINE";
    let payment_status =
      currentOrder.paymentDetails.method === "COD" ? "PENDING" : "PAID";

    const payload = {
      orderId: `${currentOrder.orderId}`,
      orderSubtype: "FORWARD",
      currency: "INR",
      amount: parseInt(currentOrder.paymentDetails.amount),
      weight: Number(currentOrder.packageDetails.applicableWeight) * 1000 || 1,
      lineItems: lineItems,
      paymentType: payment_type,
      paymentStatus: payment_status,
      length:
        Number(currentOrder.packageDetails?.volumetricWeight?.length) || 1,
      height:
        Number(currentOrder.packageDetails?.volumetricWeight?.height) || 1,
      width: Number(currentOrder.packageDetails?.volumetricWeight?.width) || 1,

      billingAddress: {
        name: `${currentOrder.pickupAddress.contactName}`,
        phone: currentOrder.pickupAddress.phoneNumber.toString(),
        address1: currentOrder.pickupAddress.address,
        // address2: currentOrder.Biling_details.address2,
        city: currentOrder.pickupAddress.city,
        state: currentOrder.pickupAddress.state,
        country: "India",
        zip: `${currentOrder.pickupAddress.pinCode}`,
      },
      shippingAddress: {
        name: `${currentOrder.receiverAddress.contactName}`,
        phone: currentOrder.receiverAddress.phoneNumber.toString(),
        address1: currentOrder.receiverAddress.address,
        // address2: currentOrder.receiverAddress.address2,
        city: currentOrder.receiverAddress.city,
        state: currentOrder.receiverAddress.state,
        country: "India",
        zip: `${currentOrder.receiverAddress.pinCode}`,
      },
      pickupAddress: {
        name: `${currentOrder.pickupAddress.contactName}`,
        phone: currentOrder.pickupAddress.phoneNumber.toString(),
        address1: currentOrder.pickupAddress.address,
        // address2: wh.addressLine2,
        city: currentOrder.pickupAddress.city,
        state: currentOrder.pickupAddress.state,
        country: "India",
        zip: `${currentOrder.pickupAddress.pinCode}`,
      },
      returnAddress: {
        name: `${currentOrder.pickupAddress.contactName}`,
        phone: currentOrder.pickupAddress.phoneNumber.toString(),
        address1: currentOrder.pickupAddress.address,
        // address2: wh.addressLine2,
        city: currentOrder.pickupAddress.city,
        state: currentOrder.pickupAddress.state,
        country: "India",
        zip: `${currentOrder.pickupAddress.pinCode}`,
      },
      selectedCarriers: [
        {
          shortName: "SMILE",
        },
      ],
      deliveryPromise:
        services.courierType === "Domestic (Surface)" ? "SURFACE" : "AIR",
    };

    const effectiveBalance =
      currentWallet.balance - (currentWallet.holdAmount || 0);
    if (currentWallet.balance < finalCharges) {
      return res
        .status(400)
        .json({ success: false, message: "Insufficient Wallet Balance" });
    }

    let response;
    if (currentWallet.balance >= finalCharges) {
      response = await axios.post(API_URL, payload, {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      });
      console.log("ressssssssssponse", response.data);
    } else {
      return res.status(401).json({ success: false, message: "Low Balance" });
    }

    if (response.status == 200) {
      const result = response.data.data;
      console.log(result);
      currentOrder.status = "Booked";
      currentOrder.cancelledAtStage = null;
      currentOrder.awb_number = result.awbNumber;
      currentOrder.shipment_id = `${result.shipperOrderId}`;
      currentOrder.provider = provider;
      currentOrder.totalFreightCharges = finalCharges;
      currentOrder.shipmentCreatedAt = new Date();
      currentOrder.courierServiceName = courierServiceName;
      currentOrder.estimatedDeliveryDate=estimatedDeliveryDate;
      currentOrder.tracking.push({
        status: "Booked",
        StatusLocation: currentOrder.pickupAddress?.city || "N/A",
        StatusDateTime: new Date(),
        Instructions: "Order booked successfully",
      });
      //   currentOrder.service_details = selectedServiceDetails._id;
      //   currentOrder.freightCharges =
      //     req.body.finalCharges === "N/A" ? 0 : parseInt(req.body.finalCharges);
      //   currentOrder.tracking = [];
      //   currentOrder.tracking.push({
      //     stage: "Order Booked",
      //   });
      await currentOrder.save();
      let balanceToBeDeducted =
        finalCharges === "N/A" ? 0 : parseInt(finalCharges);
      //   let currentBalance = currentWallet.balance - balanceToBeDeducted;
      await currentWallet.updateOne({
        $inc: { balance: -balanceToBeDeducted },
        $push: {
          transactions: {
            channelOrderId: currentOrder.orderId || null, // Include if available
            category: "debit",
            amount: balanceToBeDeducted, // Fixing incorrect reference
            balanceAfterTransaction:
              currentWallet.balance - balanceToBeDeducted,
            date: new Date().toISOString().slice(0, 16).replace("T", " "),
            awb_number: result.awbNumber || "", // Ensuring it follows the schema
            description: `Freight Charges Applied`,
          },
        },
      });

      // --- Call Manifest API ---
      try {
        const manifestResponse = await axios.post(
          `${BASE_URL}/fulfillment/public/seller/order/create-manifest`,
          {
            awbNumber: [result.awbNumber], // Order AWB
            // cAwbNumber: result.cAwbNumber || "", // Courier AWB (if available)
          },
          {
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
          }
        );

        console.log("Manifest Created:", manifestResponse.data);
      } catch (manifestErr) {
        console.error(
          "Error creating manifest:",
          manifestErr.response?.data || manifestErr.message
        );
        // You can decide whether to fail here or just log and continue
      }

      return res
        .status(201)
        .json({ message: "Shipment & Manifest Created Successfully" });
    } else {
      return res
        .status(400)
        .json({ error: "Error creating shipment", details: response.data });
    }
  } catch (error) {
    console.log("errrororororo", error.response.data);
    // console.error("Error in creating shipment:", error.message);
    return res
      .status(500)
      .json({ error: "Internal Server Error", message: error.message });
  }
};

// Cancel Order
const cancelOrderShreeMaruti = async (order_Id) => {
  const payload = {
    orderId: `${order_Id}`,
    cancelReason: "Cancel by customer",
  };

  try {
    const token = await getToken();

    const response = await axios.put(
      `${BASE_URL}/fulfillment/public/seller/order/cancel-order`,
      payload,
      {
        headers: {
          "Content-Type": "application/json", // Fixed header
          Authorization: `Bearer ${token}`, // Token added
        },
      }
    );

    console.log("Response:", response);

    if (response.status === 200) {
      await Order.updateOne(
        { orderId: order_Id },
        { $set: { status: "Cancelled" } }
      );
      // Correct status check
      return {
        success: true,
        data: response.data,
      };
    } else {
      return {
        error: "Error in shipment cancellation",
        details: response.data,
        code: response.status,
      };
    }
  } catch (error) {
    console.error("Error:", error.response?.data || error.message);
    return {
      error: "Internal Server Error",
      message: error.response?.data || error.message,
      code: error.response?.status || 500,
    };
  }
};

// Download Label and Invoice
const downloadLabelInvoice = async (req, res) => {
  const { awbNumber, cAwbNumber } = req.query; // Extracting query parameters

  if (!awbNumber || !cAwbNumber) {
    return res
      .status(400)
      .json({ error: "awbNumber and cAwbNumber are required" });
  }

  try {
    const response = await axios.get(
      `${BASE_URL}/fulfillment/public/seller/order/download/label-invoice`,
      {
        params: { awbNumber, cAwbNumber }, // Passing query parameters
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    res.status(200).json(response.data);
  } catch (error) {
    console.error(
      "Error downloading label/invoice:",
      error.response?.data || error.message
    );
    res.status(500).json({
      error: "Download failed",
      details: error.response?.data || error.message,
    });
  }
};

// Create Manifest
const createManifest = async (req, res) => {
  // console.log("Request Body:", req.body);

  // Extract the AWB numbers from the request body keys
  const awbNumbers = Object.keys(req.body); // Converts { '56050528810081': '' } to ['56050528810081']

  // Construct the payload with the required structure
  const payload = {
    awbNumber: awbNumbers, // Ensure awbNumber is an array
    // cAwbNumber: [] // If needed, otherwise remove this field
  };

  try {
    const token = await getToken();
    // console.log(token,"hhhhhhhhhh",awbNumbers)// Ensure token is fetched correctly
    const response = await axios.post(
      `${BASE_URL}/fulfillment/public/seller/order/create-manifest`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );
    console.log("jkkkkkkkkkkkkk", response.data);

    res.status(200).json(response.data);
  } catch (error) {
    console.error(
      "Error creating manifest:",
      error.response?.data || error.message
    );
    res.status(500).json({
      error: "Manifest creation failed",
      details: error.response?.data || error.message,
    });
  }
};

// Track Order
const trackOrderShreeMaruti = async (awbNumber) => {
  // console.log("awbNumber",awbNumber)
  if (!awbNumber) {
    return {
      success: false,
      data: "Waybill number is required",
    };
  }
  const token = await getToken();
  // console.log("tokennnnnnn", token);
  try {
    const response = await axios.get(`${BASE_URL}/tracking/v2/${awbNumber}`, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
    });
    // console.log("ressssssss", response.data.statuses);

    return {
      success: true,
      data: response.data.statuses,
    };
  } catch (error) {
    console.error(
      "Error tracking order:",
      error.response?.data || error.message
    );
    // console.log(error);

    return {
      success: false,
      data: "Error in tracking",
    };
  }
};
// trackOrderShreeMaruti("SHIP40000000002");

// Serviceability
const checkServiceabilityShreeMaruti = async (payload) => {
  const { fromPincode, toPincode, isCodOrder, deliveryMode } = payload;
  if (!fromPincode || !toPincode || isCodOrder === undefined || !deliveryMode) {
    return {
      error:
        "Missing required fields: fromPincode, toPincode, isCodOrder, and deliveryMode are mandatory.",
    };
  }

  try {
    const token = await getToken();
    const response = await axios.post(
      `${BASE_URL}/fulfillment/public/seller/order/check-ecomm-order-serviceability`,
      { fromPincode, toPincode, isCodOrder, deliveryMode },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      }
    );

    // console.log("shreemaruti",response.data)

    if (response && response.data && response.data.data) {
      if (response.data.data.serviceability) {
        return { success: true };
      } else {
        return { success: false };
      }
    } else {
      // console.error("Unexpected response structure:", response);
      return { success: false };
    }
  } catch (error) {
    if (error.response) {
      // console.error("API error response:", error.response.data);
      return { success: false };
    } else {
      // console.error("Request error:", error.message);
      return { success: false };
    }
    return { success: false };
  }
};

module.exports = {
  createOrder,
  cancelOrderShreeMaruti,
  downloadLabelInvoice,
  createManifest,
  trackOrderShreeMaruti,
  checkServiceabilityShreeMaruti,
  getCourierList,
  addService,
};
