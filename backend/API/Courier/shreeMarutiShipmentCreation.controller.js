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
const WalletTransaction = require("../../models/WalletTransaction.model");
const { getZone } = require("../../Rate/zoneManagementController");
const estimatedDeliveryDate = require("../../models/EDDMap.model");
const { assignPickupManifest } = require("../../Orders/scheduledPickup.controller");

const createShreeMarutiShipment = async ({
  id,
  provider,
  finalCharges,
  courierServiceName,
  priceBreakup,
  userId,
  walletId,
  walletBalance,
  walletHoldAmount,
  walletCreditLimit,
}) => {
  const API_URL = `${BASE_URL}/fulfillment/public/seller/order/ecomm/push-order`;
  const MANIFEST_API = `${BASE_URL}/fulfillment/public/seller/order/create-manifest`;
  const token = await getToken();
  const session = await mongoose.startSession();
  let currentOrder, zone, estimateDate = null, result, balanceToBeDeducted;

  try {
    session.startTransaction();

    const services = await Services.findOne({
      name: courierServiceName,
    }).session(session);

    // Atomically lock the order
    currentOrder = await Order.findOneAndUpdate(
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

    zone = await getZone(
      currentOrder.pickupAddress.pinCode,
      currentOrder.receiverAddress.pinCode
    );

    // Step 5️⃣ Fetch estimated delivery date from DB
    const eddData = await estimatedDeliveryDate.findOne({
      courier: "Shree Maruti",
      serviceName: courierServiceName.trim(),
    });

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
    const effectiveBalance = walletBalance - walletHoldAmount;
    const balance = effectiveBalance + walletCreditLimit;
    if (balance < finalCharges) {
      // abortTransaction() alone reverts the uncommitted "processing" write.
      await session.abortTransaction();
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
      // abortTransaction() alone reverts the uncommitted "processing" write
      // — a separate write here before the abort would self-deadlock on
      // this transaction's own lock until MongoDB force-aborts it (60s).
      await session.abortTransaction();
      session.endSession();
      console.error(
        "Shipment API failed:",
        shipmentErr.response?.data || shipmentErr.message
      );
      return {
        success: false,
        message: shipmentErr.response?.data?.message || shipmentErr.message || "Shipment creation failed",
      };
    }

    if (response.status === 200) {
      result = response.data.data;

      balanceToBeDeducted = parseFloat(finalCharges);

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

      await Promise.all([
        Wallet.updateOne(
          { _id: walletId },
          {
            $inc: { balance: -balanceToBeDeducted },
          },
          { session }
        ),
        WalletTransaction.create(
          [
            {
              walletId: walletId,
              channelOrderId: currentOrder.orderId || null,
              category: "debit",
              amount: balanceToBeDeducted,
              balanceAfterTransaction: walletBalance - balanceToBeDeducted,
              date: new Date(),
              awb_number: result.awbNumber || "",
              description: `Freight Charges Applied`,
              priceBreakup
            }
          ],
          { session }
        )
      ]);

      await session.commitTransaction();
      session.endSession();

      // ── Auto-assign pickup manifest (groups by date + address + courier) (non-blocking) ──
      Order.findById(currentOrder._id)
        .then((freshOrder) => {
          if (freshOrder) assignPickupManifest(freshOrder);
        })
        .catch((pErr) => {
          console.error("[Pickup] assignPickupManifest failed (non-blocking):", pErr.message);
        });

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
      // See earlier comment — abortTransaction() alone reverts the status.
      await session.abortTransaction();
      session.endSession();
      return {
        success: false,
        message: response.data?.message || "Error creating shipment",
      };
    }
  } catch (error) {
    // See earlier comment — abortTransaction() alone reverts the status.
    if (session.inTransaction()) await session.abortTransaction();
    session.endSession();

    if (result?.awbNumber) {
      // Shree Maruti already confirmed a real, irreversible shipment before
      // this failure hit (e.g. a write conflict during the commit) —
      // recover by persisting directly instead of reporting failure and
      // losing the AWB.
      console.error(`[ShreeMaruti] AWB ${result.awbNumber} was already placed when this failed (${error.message}). Recovering instead of reporting failure.`);
      try {
        await Promise.all([
          Order.findByIdAndUpdate(id, {
            $set: {
              status: "Booked",
              cancelledAtStage: null,
              awb_number: result.awbNumber,
              shipment_id: result.shipperOrderId,
              provider: provider,
              totalFreightCharges: finalCharges,
              shipmentCreatedAt: new Date(),
              courierServiceName,
              estimatedDeliveryDate: estimateDate,
              zone: zone?.zone,
              priceBreakup,
            },
            $push: {
              tracking: {
                status: "Booked",
                StatusLocation: currentOrder?.pickupAddress?.city || "N/A",
                StatusDateTime: new Date(),
                Instructions: "Order booked successfully (recovered after a DB write conflict)",
              },
            },
          }),
          Wallet.updateOne({ _id: walletId }, { $inc: { balance: -balanceToBeDeducted } }),
          WalletTransaction.create([
            {
              walletId: walletId,
              channelOrderId: currentOrder?.orderId || null,
              category: "debit",
              amount: balanceToBeDeducted,
              balanceAfterTransaction: walletBalance - balanceToBeDeducted,
              date: new Date(),
              awb_number: result.awbNumber || "",
              description: `Freight Charges Applied`,
              priceBreakup,
            },
          ]),
        ]);
      } catch (saveErr) {
        console.error(`[ShreeMaruti] CRITICAL: could not save recovered AWB ${result.awbNumber} for order ${id} — needs manual reconciliation:`, saveErr.message);
      }
      return {
        success: true,
        message: "Shipment Created Successfully",
        awb_number: result.awbNumber,
      };
    }

    console.error("Error:", error.response?.data || error.message);
    const shreeMarutiReason = error.response?.data?.message || error.message;
    return {
      success: false,
      message: shreeMarutiReason || "Internal Server Error",
      error: shreeMarutiReason || "Internal Server Error",
    };
  }
};
module.exports = createShreeMarutiShipment;
