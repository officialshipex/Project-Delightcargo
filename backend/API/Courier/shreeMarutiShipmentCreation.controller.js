const BASE_URL = process.env.SHREEMA_PRODUCTION_URL;
const {
  getToken,
} = require("../../AllCouriers/ShreeMaruti/Authorize/shreeMaruti.controller");
const mongoose = require("mongoose");
const axios = require("axios");
const Services = require("../../models/CourierService.Schema");
const Order = require("../../models/newOrder.model");
const user = require("../../models/User.model");
const Wallet = require("../../models/wallet");
const { getZone } = require("../../Rate/zoneManagementController");
const estimatedDeliveryDate = require("../../models/EDDMap.model");
const { assignPickupManifest } = require("../../Orders/scheduledPickup.controller");

const createShreeMarutiShipment = async ({
  id,
  provider,
  finalCharges,
  courierServiceName,
  priceBreakup
}) => {
  const API_URL = `${BASE_URL}/fulfillment/public/seller/order/ecomm/push-order`;
  const MANIFEST_API = `${BASE_URL}/fulfillment/public/seller/order/create-manifest`;
  const token = await getToken();
  const session = await mongoose.startSession();

  try {
    session.startTransaction();

    const services = await Services.findOne({
      name: courierServiceName,
    }).session(session);

    // Atomically lock the order
    let currentOrder = await Order.findOneAndUpdate(
      { _id: id, status: "new" },
      { $set: { status: "processing" } },
      { new: true, session }
    );

    if (!currentOrder) {
      await session.abortTransaction();
      session.endSession();
      return {
        success: false,
        message: "Order is already being processed or not in 'new' status.",
      };
    }

    const users = await user.findById(currentOrder.userId).session(session);
    const currentWallet = await Wallet.findById(users.Wallet).session(session);
    const zone = await getZone(
      currentOrder.pickupAddress.pinCode,
      currentOrder.receiverAddress.pinCode
    );

    // Step 5️⃣ Fetch estimated delivery date from DB
    const eddData = await estimatedDeliveryDate.findOne({
      courier: "Shree Maruti",
      serviceName: courierServiceName.trim(),
    });

    let estimateDate = null;
    if (eddData) {
      let deliveryDays = null;
      if (
        eddData.zoneRates &&
        typeof eddData.zoneRates[zone.zone] === "number"
      ) {
        deliveryDays = eddData.zoneRates[zone.zone];
      } else if (typeof eddData[zone.zone] === "number") {
        deliveryDays = eddData[zone.zone];
      }
      if (deliveryDays) {
        estimateDate = new Date();
        estimateDate.setDate(estimateDate.getDate() + deliveryDays);
      }
    }

    // Wallet balance check
    const effectiveBalance =
      currentWallet.balance - (currentWallet.holdAmount || 0);
    const balance = effectiveBalance + currentWallet.creditLimit;
    if (balance < finalCharges) {
      await session.abortTransaction();
      await Order.findByIdAndUpdate(id, { status: "new" });
      session.endSession();
      return { success: false, message: "Insufficient Wallet Balance" };
    }

    // Construct line items
    const lineItems = currentOrder.productDetails.map((item) => ({
      name: item.name,
      quantity: Number(item.quantity) || 0,
      price: Number(item.unitPrice) * Number(item.quantity) || 0,
      unitPrice: Number(item.unitPrice) || 0,
      weight: currentOrder.packageDetails?.applicableWeight
        ? Math.max(
          Number(currentOrder.packageDetails.applicableWeight) * 1000,
          1
        )
        : 1,
      sku: item.sku || null,
    }));

    const payment_type =
      currentOrder.paymentDetails.method === "COD" ? "COD" : "ONLINE";
    const payment_status =
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
        name: currentOrder.pickupAddress.contactName,
        phone: currentOrder.pickupAddress.phoneNumber.toString(),
        address1: currentOrder.pickupAddress.address,
        city: currentOrder.pickupAddress.city,
        state: currentOrder.pickupAddress.state,
        country: "India",
        zip: currentOrder.pickupAddress.pinCode,
      },
      shippingAddress: {
        name: currentOrder.receiverAddress.contactName,
        phone: currentOrder.receiverAddress.phoneNumber.toString(),
        address1: currentOrder.receiverAddress.address,
        city: currentOrder.receiverAddress.city,
        state: currentOrder.receiverAddress.state,
        country: "India",
        zip: currentOrder.receiverAddress.pinCode,
      },
      pickupAddress: {
        name: currentOrder.pickupAddress.contactName,
        phone: currentOrder.pickupAddress.phoneNumber.toString(),
        address1: currentOrder.pickupAddress.address,
        city: currentOrder.pickupAddress.city,
        state: currentOrder.pickupAddress.state,
        country: "India",
        zip: currentOrder.pickupAddress.pinCode,
      },
      returnAddress: {
        name: currentOrder.pickupAddress.contactName,
        phone: currentOrder.pickupAddress.phoneNumber.toString(),
        address1: currentOrder.pickupAddress.address,
        city: currentOrder.pickupAddress.city,
        state: currentOrder.pickupAddress.state,
        country: "India",
        zip: currentOrder.pickupAddress.pinCode,
      },
      selectedCarriers: [{ shortName: "SMILE" }],
      deliveryPromise:
        services.courierType === "Domestic (Surface)" ? "SURFACE" : "AIR",
    };

    // --- Call Shipment API ---
    let response;
    try {
      response = await axios.post(API_URL, payload, {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      });
    } catch (shipmentErr) {
      await Order.findByIdAndUpdate(id, { status: "new" });
      await session.abortTransaction();
      session.endSession();
      console.error(
        "Shipment API failed:",
        shipmentErr.response?.data || shipmentErr.message
      );
      return {
        success: false,
        message: "Shipment creation failed",
        details: shipmentErr.response?.data || shipmentErr.message,
      };
    }

    if (response.status === 200) {
      const result = response.data.data;

      const balanceToBeDeducted = parseInt(finalCharges);

      currentOrder.status = "Booked";
      currentOrder.cancelledAtStage = null;
      currentOrder.awb_number = result.awbNumber;
      currentOrder.shipment_id = result.shipperOrderId;
      currentOrder.provider = provider;
      currentOrder.totalFreightCharges = finalCharges;
      currentOrder.shipmentCreatedAt = new Date();
      currentOrder.courierServiceName = courierServiceName;
      currentOrder.estimatedDeliveryDate = estimateDate;
      currentOrder.zone = zone.zone;
      currentOrder.priceBreakup = priceBreakup;
      currentOrder.tracking.push({
        status: "Booked",
        StatusLocation: currentOrder.pickupAddress?.city || "N/A",
        StatusDateTime: new Date(),
        Instructions: "Order booked successfully",
      });

      await currentOrder.save({ session });

      await currentWallet.updateOne(
        {
          $inc: { balance: -balanceToBeDeducted },
          $push: {
            transactions: {
              channelOrderId: currentOrder.orderId || null,
              category: "debit",
              amount: balanceToBeDeducted,
              balanceAfterTransaction:
                currentWallet.balance - balanceToBeDeducted,
              date: new Date(),
              awb_number: result.awbNumber || "",
              description: `Freight Charges Applied`,
            },
          },
        },
        { session }
      );

      await session.commitTransaction();
      session.endSession();

      // ── Auto-assign pickup manifest (groups by date + address + courier) ──
      // try {
      //   const freshOrder = await Order.findById(currentOrder._id);
      //   if (freshOrder) await assignPickupManifest(freshOrder);
      // } catch (pErr) {
      //   console.error("[Pickup] assignPickupManifest failed (non-blocking):", pErr.message);
      // }

      // --- Call Manifest API (outside transaction) ---
      try {
        const manifestResponse = await axios.post(
          MANIFEST_API,
          { awbNumber: [result.awbNumber] },
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
      }

      return {
        success: true,
        message: "Shipment & Manifest Created Successfully",
        awb_number: result.awbNumber,
      };
    } else {
      await Order.findByIdAndUpdate(id, { status: "new" });
      await session.abortTransaction();
      session.endSession();
      return {
        success: false,
        message: "Error creating shipment",
        details: response.data,
      };
    }
  } catch (error) {
    await Order.findByIdAndUpdate(id, { status: "new" });
    await session.abortTransaction();
    session.endSession();
    console.error("Error:", error.response?.data || error.message);
    return {
      success: false,
      message: "Internal Server Error",
      error: error.message,
    };
  }
};
module.exports = createShreeMarutiShipment;
