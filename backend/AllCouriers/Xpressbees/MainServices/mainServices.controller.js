if (process.env.NODE_ENV != "production") {
  require("dotenv").config();
}

const axios = require("axios");
const Order = require("../../../models/newOrder.model");
const { getToken } = require("../Authorize/XpressbeesAuthorize.controller");
const Wallet = require("../../../models/wallet");
const WalletTransaction = require("../../../models/WalletTransaction.model");
const user = require("../../../models/User.model");
const BASE_URL = process.env.XpreesbeesUrl;
const plan = require("../../../models/Plan.model");
const { getZone } = require("../../../Rate/zoneManagementController")
const { assignPickupManifest } = require("../../../Orders/scheduledPickup.controller");

const createShipment = async (req, res) => {
  const url = `${BASE_URL}/api/shipments2`;
  const { courierServiceName, id, provider, finalCharges } = req.body;
  const currentOrder = await Order.findById(id);
  const users = await user.findById({ _id: currentOrder.userId });
  const plans = await plan.findOne({ userId: currentOrder.userId });

  if (currentOrder.status !== "new") {
    return res.status(400).json({
      success: false,
      message: `Shipment cannot be created because order status is '${currentOrder.status}'.`,
    });
  }

  const zone = await getZone(
    currentOrder.pickupAddress.pinCode,
    currentOrder.receiverAddress.pinCode
  );

  const services = await courierService.findOne({ name: courierServiceName });

  console.log("services", services.courier);

  const courierServices = [
    { id: "6", name: "Air Xpressbees 0.5 K.G" },
    { id: "8", name: "Express Reverse" },
    { id: "1", name: "Surface Xpressbees 0.5 K.G" },
    { id: "12298", name: "Xpressbees 1 K.G" },
    { id: "4", name: "Xpressbees 10 K.G" },
    { id: "2", name: "Xpressbees 2 K.G" },
    { id: "3", name: "Xpressbees 5 K.G" },
    { id: "12939", name: "Xpressbees Next Day Delivery" },
    { id: "12938", name: "Xpressbees Same Day Delivery" },
  ];

  const currentWallet = await Wallet.findById({ _id: users.Wallet }).select("balance holdAmount creditLimit");
  const order_items = new Array(currentOrder.productDetails.length);

  currentOrder.productDetails.map((item, index) => {
    order_items[index] = {
      name: item.name,
      qty: item.quantity,
      price: item.unitPrice,
      sku: item.sku,
    };
  });
  let payment_type =
    currentOrder.paymentDetails.method === "COD" ? "cod" : "prepaid";

  // find the courier id
  const selectedCourier = courierServices.find(
    (service) => service.name === services.courier
  );
  const courierId = selectedCourier ? selectedCourier.id : null;

  const shipmentData = {
    order_number: `${currentOrder.orderId}`,
    payment_type,
    package_weight: currentOrder.packageDetails.applicableWeight * 1000,
    package_length: currentOrder.packageDetails.volumetricWeight.length,
    package_breadth: currentOrder.packageDetails.volumetricWeight.width,
    package_height: currentOrder.packageDetails.volumetricWeight.height,
    order_amount: currentOrder.paymentDetails.amount,
    request_auto_pickup: "yes",
    consignee: {
      name: `${currentOrder.receiverAddress.contactName}`,
      address: `${currentOrder.receiverAddress.address}`,
      city: currentOrder.receiverAddress.city,
      state: currentOrder.receiverAddress.state,
      pincode: `${currentOrder.receiverAddress.pinCode}`,
      phone: currentOrder.receiverAddress.phoneNumber,
    },
    pickup: {
      warehouse_name: `${currentOrder.pickupAddress.address.slice(0, 30)}`,
      name: `${currentOrder.pickupAddress.contactName}`,
      address: `${currentOrder.pickupAddress.address}`,
      city: currentOrder.pickupAddress.city,
      state: currentOrder.pickupAddress.state,
      pincode: `${currentOrder.pickupAddress.pinCode}`,
      phone: currentOrder.pickupAddress.phoneNumber,
    },
    order_items,
    collectable_amount:
      currentOrder.paymentDetails.method === "Prepaid"
        ? 0
        : currentOrder.paymentDetails.amount,
    courier_id: courierId,
  };
  console.log("shipmentData", shipmentData);

  try {
    const token = await getToken();
    // console.log("sadasd",shipmentData)
    let response;
    const walletHoldAmount = currentWallet?.holdAmount || 0;
    const effectiveBalance = currentWallet.balance - walletHoldAmount;
    if (effectiveBalance >= finalCharges) {
      response = await axios.post(url, shipmentData, {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      });

      console.log("res", response.data);
    } else {
      return res.status(401).json({ success: false, message: "Low Balance" });
    }
    if (response.data.status) {
      const result = response.data.data;
      currentOrder.status = "Ready To Ship";
      currentOrder.cancelledAtStage = null;
      currentOrder.awb_number = result.awb_number;
      currentOrder.label = result.label;
      currentOrder.provider = provider;
      currentOrder.shipment_id = `${result.awb_number}`;
      currentOrder.totalFreightCharges = finalCharges;
      currentOrder.shipmentCreatedAt = new Date();
      currentOrder.courierServiceName = courierServiceName;
      currentOrder.zone = zone.zone;
      // currentOrder.service_details = selectedServiceDetails._id;
      // currentOrder.freightCharges =
      // req.body.finalCharges === "N/A" ? 0 : parseInt(req.body.finalCharges);
      // currentOrder.tracking = [];

      // console.log("sahkdjhsakdsa",currentOrder)
      await currentOrder.save();

      // ── Auto-assign pickup manifest ──
      try {
        await assignPickupManifest(currentOrder);
      } catch (pErr) {
        console.error("[Pickup] assignPickupManifest failed:", pErr.message);
      }

      let balanceToBeDeducted =
        finalCharges === "N/A" ? 0 : parseInt(finalCharges);
      // console.log("sjakjska",balanceToBeDeducted)
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
        awb_number: result.awb_number || "",
        description: "Freight Charges Applied",
      }).catch(e => console.error("⚠️ WalletTransaction dual-write failed (createShipment Xpressbees):", e.message));

      return res.status(201).json({ message: "Shipment Created Succesfully" });
    } else {
      return res
        .status(400)
        .json({ error: "Error creating shipment", details: response.data });
    }
  } catch (error) {
    // console.log(error);
    console.error("Error in creating shipment:", error.response);
    return res.status(500).json({
      error: "Internal Server Error",
      message: error.response.data.message,
    });
  }
};

const reverseBooking = async (req, res) => {
  const { shipmentData } = req.body;
  const url = `${BASE_URL}/api/reverseshipments`;

  try {
    const token = await getToken();
    const response = await axios.post(url, shipmentData, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
    });

    if (response.data.status) {
      return res.status(201).json(response.data.data);
    } else {
      return res.status(400).json({
        error: "Error creating reverse booking",
        details: response.data,
      });
    }
  } catch (error) {
    console.error("Error in creating reverse booking:", error.message);
    return res
      .status(500)
      .json({ error: "Internal Server Error", message: error.message });
  }
};

const trackShipment = async (trackingNumber) => {
  if (!trackingNumber) {
    return {
      success: false,
      data: "Error in tracking",
    };
  }

  const url = `${BASE_URL}/api/shipments2/track/${trackingNumber}`;

  try {
    const token = await getToken();
    const response = await axios.get(url, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
    });

    if (response.data.status) {
      return {
        success: true,
        data: response.data.data.status,
      };
    } else {
      return {
        success: false,
        data: "Error in message",
      };
    }
  } catch (error) {
    console.log(error);
    return {
      success: false,
      data: "Error in message",
    };
  }
};

const pickup = async (awbNumbers) => {
  if (!awbNumbers || !Array.isArray(awbNumbers) || awbNumbers.length === 0) {
    return { error: "AWB numbers must be a non-empty array" };
  }

  const url = `${BASE_URL}/api/shipments2/manifest`;

  try {
    const token = await getToken();
    const payload = { awbs: awbNumbers };

    const response = await axios.post(url, payload, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
    });

    console.log("response of xpressbees pickup", response.data);

    if (response.data.status) {
      return { success: true, data: response.data.data };
    } else {
      return {
        success: false,
        error: "Error in manifest creation",
        details: response.data,
      };
    }
  } catch (error) {
    console.error(
      "Error in creating manifest:",
      error.response?.data || error.message
    );
    return {
      success: false,
      error: "Internal Server Error",
      message: error.message,
    };
  }
};

const cancelShipmentXpressBees = async (awb) => {
  if (!awb) {
    return res.status(400).json({ error: "AWB number is required" });
  }

  const url = `${BASE_URL}/api/shipments2/cancel`;
  try {
    const token = await getToken();
    const payload = { awb };
    // console.log("sadsdsads",awb)
    // console.log("sadsdsads",token)
    const response = await axios.post(url, payload, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
    });
    // console.log("dsssssssssss",response)
    // await Order.updateOne(
    //   { awb_number: awb },
    //   { $set: { status: "Cancelled" } }
    // );

    const { status, data } = response.data;
    console.log("huuuuu");
    if (status) {
      await Order.updateOne(
        { awb_number: awb },
        { $set: { status: "Cancelled" } }
      );
      return { data, code: 201 };
    } else {
      return {
        error: "Error in shipment cancellation",
        details: response.data,
        code: 400,
      };
    }
  } catch (error) {
    console.error(
      "Error in cancelling shipment:",
      error.response?.data || error.message
    );
    return {
      error: "Internal Server Error",
      message: error.message,
      code: 500,
    };
  }
};

const exceptionList = async (req, res) => {
  try {
    const token = await getAuthToken();
    const url = `${BASE_URL}/api/ndr`;
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: error.response?.data || error.message });
  }
};

const createNDR = async (req, res) => {
  const ndrActions = req.body;

  if (!Array.isArray(ndrActions) || ndrActions.length === 0) {
    return res
      .status(400)
      .json({ error: "Invalid input. NDR actions must be a non-empty array." });
  }

  const url = `${BASE_URL}/api/ndr/create`;

  try {
    const token = await getAuthToken();

    const response = await axios.post(url, ndrActions, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
    });

    if (response.data.some((item) => !item.status)) {
      console.warn(
        "Some actions failed:",
        response.data.filter((item) => !item.status)
      );
      return res.status(207).json({
        // HTTP 207 for partial success
        message: "Some actions failed",
        data: response.data,
      });
    }

    return res.status(200).json({
      message: "All actions performed successfully",
      data: response.data,
    });
  } catch (error) {
    console.error(
      "Error in performing NDR actions:",
      error.response?.data || error.message
    );
    return res.status(500).json({
      error: "Internal Server Error",
      message: error.response?.data?.message || error.message,
    });
  }
};

const checkServiceabilityXpressBees = async (service, payload) => {
  console.log("I am in xpress serviceability");

  const {
    origin,
    destination,
    payment_type,
    order_amount,
    weight,
    length,
    breadth,
    height,
  } = payload;

  try {
    const token = await getToken();
    // console.log(token);

    const response = await axios.post(
      `${BASE_URL}/api/courier/serviceability`,
      {
        origin,
        destination,
        payment_type,
        order_amount,
        weight,
        length,
        breadth,
        height,
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      }
    );
    // console.log("clkxlkc",response.data);
    if (response.data.status) {
      const result = response.data?.data;
      // console.log("uuuuuu",result)
      const filteredData = result.filter((item) => item.name === service);
      const Xpressbeesid = filteredData.map((value) => value.id);

      if (filteredData.length > 0) {
        // console.log("hii")
        return {
          success: true,
          Xpressbeesid: Xpressbeesid,
        };
      } else {
        console.log(`No courier service found matching: ${service}`);
        return false;
      }
    }
  } catch (error) {
    console.log(error);
    return false;
  }
};

module.exports = {
  createShipment,
  reverseBooking,
  createNDR,
  exceptionList,
  cancelShipmentXpressBees,
  pickup,
  trackShipment,
  checkServiceabilityXpressBees,
};
