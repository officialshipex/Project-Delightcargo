const axios = require("axios");
const { getAuthToken } = require("../Authorize/zipyPost.controller");
require("dotenv").config();
const Order = require("../../../models/newOrder.model");
const User = require("../../../models/User.model");
const Wallet = require("../../../models/wallet");
const CourierService = require("../../../models/CourierService.Schema");
const PickupAddress = require("../../../models/pickupAddress.model");
const { getZone } = require("../../../Rate/zoneManagementController");
const mongoose = require("mongoose");

const createWarehouse = async (
  userId,
  warehouseData,
  authToken,
  timestamp,
  sellerId
) => {
  try {
    // console.log("warehouse",warehouseData)
    const pickupAddress = await PickupAddress.findOne({
      userId,
      "pickupAddress.pinCode": warehouseData.pincode,
    });
    // console.log("pickup address",pickupAddress)
    if (!pickupAddress) {
      return {
        success: false,
      };
    }
    if (pickupAddress.zipypostHubId) {
      // console.log("✅ Smartship Hub already registered:", pickupAddress.smartshipHubId);
      return {
        success: true,
        warehouseId: pickupAddress.zipypostHubId,
      };
    }
    const response = await axios.post(
      "https://api.zipypost.com/create/warehouse",
      warehouseData,
      {
        headers: {
          "Content-Type": "application/json",
          authorization: authToken,
          timestamp: timestamp,
          sellerId: sellerId,
        },
      }
    );

    if (response.data.success) {
      console.log("warehouse", response.data);
      pickupAddress.zipypostHubId = response.data.warehouse_id;
      await pickupAddress.save();
      return {
        success: true,
        warehouseId: response.data.warehouse_id,
      };
    } else {
      console.error("Failed to create warehouse:", response.data.message);
      return null;
    }
  } catch (error) {
    console.error(
      "Error creating warehouse:",
      error.response?.data || error.message
    );
    return null;
  }
};

const createZipypostOrder = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const {
      id,
      provider,
      finalCharges,
      courierServiceName,
      courier,
      estimatedDeliveryDate,
    } = req.body;

    const currentOrder = await Order.findById(id).session(session);
    if (!currentOrder) {
      throw new Error("Order not found");
    }

    if (currentOrder.status !== "new") {
      throw new Error(
        `Shipment cannot be created because order status is '${currentOrder.status}'.`
      );
    }

    const user = await User.findById(currentOrder.userId).session(session);
    if (!user) {
      throw new Error("User not found");
    }

    const currentWallet = await Wallet.findById(user.Wallet).session(session);
    if (!currentWallet) {
      throw new Error("Wallet not found");
    }

    const walletHoldAmount = currentWallet?.holdAmount || 0;
    const effectiveBalance = currentWallet.balance - walletHoldAmount;
    if (effectiveBalance < finalCharges) {
      throw new Error("Insufficient Wallet Balance");
    }

    const zone = await getZone(
      currentOrder.pickupAddress.pinCode,
      currentOrder.receiverAddress.pinCode
    );
    if (!zone) {
      throw new Error("Pincode not serviceable");
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const sellerId = process.env.ZIPYPOST_SELLER_ID;
    const token = await getAuthToken();

    // Call serviceability
    const payload = {
      source_pincode: currentOrder.pickupAddress.pinCode,
      destination_pincode: currentOrder.receiverAddress.pinCode,
      payment_type: currentOrder.paymentDetails?.method,
      order_weight: currentOrder.packageDetails.applicableWeight,
      length: currentOrder.packageDetails.volumetricWeight?.length || 0,
      breadth: currentOrder.packageDetails.volumetricWeight?.width || 0,
      height: currentOrder.packageDetails.volumetricWeight?.height || 0,
      order_value: currentOrder.paymentDetails?.amount || 0,
    };

    const serviceability = await checkZipypostServiceability(payload);

    if (
      !serviceability.data ||
      !Array.isArray(serviceability.data) ||
      serviceability.data.length === 0
    ) {
      throw new Error("No serviceability data found");
    }

    // Filter supported couriers
    const validCouriers = serviceability.data.filter(
      (svc) => svc.courier_id === 9 || svc.courier_id === 10
    );

    let courier_id = 0;
    if (courierServiceName.toLowerCase().includes("xpressbees")) courier_id = 9;
    else if (courierServiceName.toLowerCase().includes("bluedart"))
      courier_id = 10;

    if (courier_id === 0) {
      throw new Error(
        "Invalid courier name. Only Xpressbees and Bluedart supported."
      );
    }

    const courierOptions = validCouriers.filter(
      (svc) => svc.courier_id === courier_id
    );

    const applicableWeight = currentOrder.packageDetails.applicableWeight;
    let selectedMode =
      courierOptions.find(
        (option) => applicableWeight <= parseFloat(option.slab)
      ) || courierOptions[courierOptions.length - 1];

    if (!selectedMode) {
      throw new Error("Unable to determine mode_id for the courier");
    }

    const mode_id = selectedMode.mode_id;

    // Prepare warehouse
    let baseName = currentOrder.pickupAddress.contactName || "Warehouse";
    baseName = baseName.substring(0, 10);
    const shortUserId = currentOrder.userId.toString().substring(0, 6);
    const finalWarehouseName =
      `${baseName}-${shortUserId}-${currentOrder.pickupAddress.pinCode}`.substring(
        0,
        30
      );

    const warehouseData = {
      warehouseName: finalWarehouseName,
      contactName: currentOrder.pickupAddress.contactName,
      contactNumber: currentOrder.pickupAddress.phoneNumber,
      AddressLineOne:
        currentOrder.pickupAddress.address?.substring(0, 45) || "",
      AddressLineTwo:
        currentOrder.pickupAddress.address?.substring(45, 90) || "",
      pincode: currentOrder.pickupAddress.pinCode,
      city: currentOrder.pickupAddress.city,
      primary: true,
    };

    const warehouseId = await createWarehouse(
      currentOrder.userId,
      warehouseData,
      token.authToken,
      timestamp,
      sellerId
    );

    if (!warehouseId.success) {
      throw new Error(
        "Pickup pincode is not registered. Please add a pickup address first."
      );
    }

    const totalProducts = currentOrder.productDetails.length;
    console.log("mode courier", mode_id, courier_id);
    const requestBody = {
      order_number: currentOrder.orderId,
      purchase_amount: currentOrder.paymentDetails.amount,
      purchase_date: currentOrder.createdAt.toISOString().split("T")[0],
      billing_details_same_as_shipping: true,
      shipping_details: {
        full_name: currentOrder.receiverAddress.contactName,
        contact_number: currentOrder.receiverAddress.phoneNumber,
        customer_email:
          currentOrder.receiverAddress.email || "example@email.com",
        address_line_one: currentOrder.receiverAddress.address,
        address_line_two: currentOrder.receiverAddress.address,
        pincode: currentOrder.receiverAddress.pinCode,
        city: currentOrder.receiverAddress.city,
      },
      billing_details: {
        full_name: currentOrder.pickupAddress.contactName,
        contact_number: currentOrder.pickupAddress.phoneNumber,
        address_line_one:
          currentOrder.pickupAddress.address?.substring(0, 45) || "",
        address_line_two:
          currentOrder.pickupAddress.address?.substring(45, 90) || "",
        pincode: currentOrder.pickupAddress.pinCode,
        city: currentOrder.pickupAddress.city,
      },
      items: currentOrder.productDetails.map((product) => ({
        sku:
          product.sku?.length >= 3 ? product.sku : `SKU${currentOrder.orderId}`,
        item_name: product.name,
        quantity: product.quantity || 1,
        item_weight:
          currentOrder.packageDetails.applicableWeight / totalProducts,
        item_price: product.unitPrice,
      })),
      package_length: currentOrder.packageDetails.length || 10,
      package_width: currentOrder.packageDetails.width || 10,
      package_height: currentOrder.packageDetails.height || 10,
      package_weight: currentOrder.packageDetails.applicableWeight || 0.5,
      warehouse_id: warehouseId.warehouseId,
      payment_type: currentOrder.paymentDetails.method === "COD" ? 2 : 1,
      courier_id,
      mode_id,
    };

    // 🔹 Call Zipypost API BEFORE committing
    const response = await axios.post(
      "https://api.zipypost.com/create/shipment",
      requestBody,
      {
        headers: {
          "Content-Type": "application/json",
          authorization: token.authToken,
          timestamp: timestamp,
          sellerid: sellerId,
        },
      }
    );

    if (!response.data.success || !response.data.booking) {
      throw new Error(response.data.message || "Failed to create shipment");
    }

    const result = response.data.RESULT;

    // ✅ Update order inside transaction
    currentOrder.status = "Booked";
    currentOrder.awb_number = result.awb;
    currentOrder.shipment_id = currentOrder.orderId;
    currentOrder.provider = result.courier;
    currentOrder.partner = "ZipyPost";
    currentOrder.shipmentCreatedAt = new Date();
    currentOrder.totalFreightCharges = finalCharges || 0;
    currentOrder.courierServiceName = courierServiceName;
    currentOrder.zone = zone.zone;
    currentOrder.estimatedDeliveryDate = estimatedDeliveryDate || "";
    currentOrder.tracking.push({
      status: "Booked",
      StatusLocation: currentOrder.pickupAddress.city,
      StatusDateTime: new Date(),
      Instructions: "Order booked successfully",
    });

    // ✅ Deduct wallet inside transaction
    currentWallet.balance -= finalCharges;
    currentWallet.transactions.push({
      channelOrderId: currentOrder.orderId,
      category: "debit",
      amount: finalCharges,
      balanceAfterTransaction: currentWallet.balance,
      date: new Date(),
      awb_number: result.awb,
      description: "Freight Charges Applied",
    });

    await currentOrder.save({ session });
    await currentWallet.save({ session });

    await session.commitTransaction();
    session.endSession();

    return res.status(200).json({
      success: true,
      message: "Shipment Created Successfully",
      data: result,
    });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.error(
      "Error creating Zipypost shipment:",
      error.response.data.error
    );
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to create shipment",
    });
  }
};

const checkZipypostServiceability = async (payload) => {
  try {
    const requestBody = {
      pickup_pincode: payload.source_pincode,
      drop_pincode: payload.destination_pincode,
      payment_type: payload.payment_type === "COD" ? 2 : 1, // 1 = Prepaid, 2 = COD (example)
      purchase_amount: payload.order_value || 100,
      length: payload.length || 5,
      width: payload.width || 5,
      height: payload.height || 5,
      weight: payload.order_weight || 0.5,
    };
    const timestamp = Math.floor(Date.now() / 1000);
    const sellerId = process.env.ZIPYPOST_SELLER_ID;
    const token = await getAuthToken();
    // console.log("token", token);
    const response = await axios.post(
      "https://api.zipypost.com/getservicepricing",
      requestBody,
      {
        headers: {
          "Content-Type": "application/json",
          authorization: token.authToken,
          timestamp: timestamp,
          sellerid: sellerId,
        },
      }
    );
    // console.log("Zipypost Serviceability Response:", response.data);
    const serviceabilityData = response.data?.result || [];
    const serviceable =
      response.data?.success === true && serviceabilityData.length > 0;

    return {
      success: serviceable,
      data: serviceabilityData,
    };
  } catch (err) {
    console.log("error", err.response.data.error);
    return {
      success: false,
      error: err.response?.data || err.message,
    };
  }
};

const cancelOrderZipypost = async (AWBNo) => {
  try {
    // Validate inputs
    if (!AWBNo) {
      return {
        success: false,
        message: "awb_number is required",
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
        success: false,
      };
    }

    // console.log("Cancel Order Request Data:", requestData);
    const timestamp = Math.floor(Date.now() / 1000);
    const sellerId = process.env.ZIPYPOST_SELLER_ID;
    const token = await getAuthToken();
    // API Call with Proper Authorization Header
    const response = await axios.get(
      `https://api.zipypost.com/cancel/shipment/${AWBNo}`,
      {
        headers: {
          authorization: token.authToken,
          timestamp: timestamp,
          sellerid: sellerId,
        },
      }
    );

    console.log("zipypost Cancel Response:", response.data);
    if (response?.data?.success) {
      await Order.updateOne(
        { awb_number: AWBNo },
        { $set: { status: "Cancelled" } }
      );
      return {
        data: response.data,
        code: 201,
      };
    } else {
      return {
        error: "Error in shipment cancellation",
        details: response.data,
        code: 400,
        success: false,
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
// cancelOrderZipypost('152489850354007')

const trackOrderZipypost = async (AWBNo) => {
  const token = await getAuthToken();
  const timestamp = Math.floor(Date.now() / 1000);
  const sellerId = process.env.ZIPYPOST_SELLER_ID;
  // console.log(access_key);

  try {
    const response = await axios.get(
      `https://api.zipypost.com/track/${AWBNo}`,
      {
        headers: {
          authorization: token.authToken,
          timestamp: timestamp,
          sellerid: sellerId,
        },
      }
    );

    console.log("response data", response.data);
    console.log("respose status", response.data.result.events);
    // console.log("response status", response.data.data.scans["20726635"][0].call_logs);
    if (response.data.success === true) {
      return { success: true, data: response.data.result.events };
    }
  } catch (error) {
    console.error(
      "Error tracking shipment:",
      error.response?.data || error.message
    );
    return {
      success: false,
      error: error.response?.data || error.message,
      status: 500,
    };
  }
};
// trackOrderZipypost("76640506445")

module.exports = {
  createWarehouse,
  createZipypostOrder,
  checkZipypostServiceability,
  cancelOrderZipypost,
  trackOrderZipypost,
};
