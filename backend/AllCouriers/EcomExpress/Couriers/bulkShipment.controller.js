const axios = require("axios");
const FormData = require("form-data");
const Order = require("../../../models/newOrder.model");
const Wallet = require("../../../models/wallet");
const WalletTransaction = require("../../../models/WalletTransaction.model");
// const User = require("../models/User");
const { fetchBulkWaybills } = require("../Authorize/saveCourierController");
const { assignPickupManifest } = require("../../../Orders/scheduledPickup.controller");

const createShipmentFunctionEcomExpress = async (serviceDetails, orderId, wh, walletId, charges) => {
  try {
    const BASE_URL = process.env.ECOMEXPRESS_SERVICE_URL;
    const url = `${BASE_URL}/services/expp/manifest/v2/expplus/`;

    // Fetch the Order
    const order = await Order.findById(orderId);
    if (!order) {
      return { success: false, message: "Order not found" };
    }

    // Check Wallet Balance before proceeding
    const wallet = await Wallet.findById(walletId).select("balance holdAmount creditLimit");
    if (!wallet) {
      return { success: false, message: "Wallet not found" };
    }

    if (wallet.balance < charges) {
      return { success: false, message: "Insufficient wallet balance" };
    }

    // Fetch a single AWB number
    const awbResponse = await fetchBulkWaybills(1);
    if (!awbResponse || awbResponse.awbNumber.success !== "yes") {
      return { success: false, message: "AWB number not generated" };
    }

    const awbNumber = awbResponse.awbNumber.awb[0];

    // Prepare Shipment Data
    const applicableWeight = Number(order.packageDetails?.applicableWeight);
    const volumetricWeight =
      (order.packageDetails?.volumetricWeight?.length *
        order.packageDetails?.volumetricWeight?.width *
        order.packageDetails?.volumetricWeight?.height) /
      5000;

    const shipmentData = [
      {
        AWB_NUMBER: awbNumber,
        ORDER_NUMBER: order.orderId,
        PRODUCT: order.paymentDetails?.method === "Prepaid" ? "PPD" : "COD",
        CONSIGNEE: order.receiverAddress.contactName,
        CONSIGNEE_ADDRESS1: order.receiverAddress.address,
        DESTINATION_CITY: order.receiverAddress.city,
        STATE: order.receiverAddress.state,
        PINCODE: order.receiverAddress.pinCode,
        MOBILE: order.receiverAddress.phoneNumber,
        ITEM_DESCRIPTION: order.productDetails?.map((item) => item.name).join(", ") || "No items",
        PIECES: order.productDetails?.length || 0,
        COLLECTABLE_VALUE: order.paymentDetails?.method === "Prepaid" ? 0 : order.paymentDetails?.amount || 0,
        DECLARED_VALUE: charges,
        ACTUAL_WEIGHT: applicableWeight,
        VOLUMETRIC_WEIGHT: volumetricWeight,
        LENGTH: order.packageDetails?.volumetricWeight?.length,
        BREADTH: order.packageDetails?.volumetricWeight?.width,
        HEIGHT: order.packageDetails?.volumetricWeight?.height,
        PICKUP_NAME: order.pickupAddress.contactName,
        PICKUP_ADDRESS_LINE1: order.pickupAddress.address,
        PICKUP_PINCODE: order.pickupAddress.pinCode,
        PICKUP_MOBILE: order.pickupAddress.phoneNumber,
        RETURN_NAME: order.pickupAddress.contactName,
        RETURN_ADDRESS_LINE1: order.pickupAddress.address,
        RETURN_PINCODE: order.pickupAddress.pinCode,
        RETURN_MOBILE: order.pickupAddress.phoneNumber,
      },
    ];

    const formData = new FormData();
    formData.append("username", process.env.ECOMEXPRESS_GMAIL);
    formData.append("password", process.env.ECOMEXPRESS_PASS);
    formData.append("json_input", JSON.stringify(shipmentData));

    // Deduct wallet balance using atomic operation
    const updatedWallet = await Wallet.findOneAndUpdate(
      { _id: walletId, balance: { $gte: charges } },
      [
        {
          $set: {
            balance: { $subtract: ["$balance", charges] },
          },
        },
      ],
      { new: true }
    );

    if (!updatedWallet) {
      return { success: false, message: "Wallet balance update failed" };
    }

    // 🔁 Dual-write: mirror to WalletTransaction for future migration
    await WalletTransaction.create({
      walletId: walletId,
      channelOrderId: order.orderId,
      category: "debit",
      amount: charges,
      balanceAfterTransaction: updatedWallet.balance,
      date: new Date(),
      awb_number: awbNumber,
      description: "Freight Charges Applied"
    });

    // Call Ecom Express API
    const response = await axios.post(url, formData, { headers: { ...formData.getHeaders() } });

    if (response.data?.shipments && response.data.shipments.length > 0) {
      const shipment = response.data.shipments[0];

      if (shipment.success) {
        // Update Order Details
        order.status = "Ready To Ship";
        order.cancelledAtStage = null;
        order.awb_number = awbNumber;
        order.shipment_id = `${order.orderId}`;
        order.provider = "EcomExpress";
        order.totalFreightCharges = charges;
        order.shipmentCreatedAt = new Date();
        order.courierServiceName = serviceDetails.courierServiceName;
        await order.save();

        // ── Auto-assign pickup manifest ──
        try {
          await assignPickupManifest(order);
        } catch (pErr) {
          console.error("[Pickup] assignPickupManifest failed:", pErr.message);
        }

        return {
          success: true,
          message: "Shipment created successfully",
          orderId: order.orderId,
          waybill: awbNumber,
        };
      } else {
        return { success: false, message: shipment.reason || "Shipment creation failed" };
      }
    } else {
      return { success: false, message: "Shipment creation failed", error: response.data };
    }
  } catch (error) {
    console.error("Shipment Creation Error:", error.response?.data || error.message);
    return { success: false, error: error.response?.data || error.message };
  }
};



module.exports = { createShipmentFunctionEcomExpress };
