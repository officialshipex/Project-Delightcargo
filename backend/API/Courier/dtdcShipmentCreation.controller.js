const axios = require("axios");
const Order = require("../../models/newOrder.model");
const User = require("../../models/User.model");
const Wallet = require("../../models/wallet");
const { getZone } = require("../../Rate/zoneManagementController");
const DTDC_API_URL = process.env.DTDC_API_URL;
const API_KEY = process.env.DTDC_API_KEY;
const X_ACCESS_TOKEN = process.env.DTDC_X_ACCESS_TOKEN;
const estimatedDeliveryDate = require("../../models/EDDMap.model");
const mongoose = require("mongoose");
const { assignPickupManifest } = require("../../Orders/scheduledPickup.controller");

/**
 * Create shipment order with given parameters
 * @param {object} params
 * @param {string} params.id - Order ID
 * @param {string} params.provider - Provider name
 * @param {number|string} params.finalCharges - Freight charges
 * @param {string} params.courierServiceName - Courier service name
 * @param {string} params.courier - Service type id (mandatory)
 * @param {string} params.API_KEY - API key for authentication
 * @param {string} params.X_ACCESS_TOKEN - Access token for authentication
 * @param {string} params.DTDC_API_URL - Base URL for DTDC API
 * @returns {Promise<object>} Result object with success status and data or error details
 */
const createDTDCShipment = async ({
  id,
  provider,
  finalCharges,
  courierServiceName,
  courier,
  priceBreakup
}) => {
  const session = await mongoose.startSession();

  try {
    if (!courier) {
      return {
        success: false,
        message: "service_type_id missing please refresh your page",
      };
    }

    session.startTransaction();

    // --- Lock and fetch order atomically ---
    const currentOrder = await Order.findOneAndUpdate(
      { _id: id, status: "new" },
      { $set: { status: "processing" } },
      { new: true, session }
    );

    if (!currentOrder) {
      await session.abortTransaction();
      session.endSession();
      return {
        success: false,
        message:
          "Shipment cannot be created because order is already processed or not in 'new' status.",
      };
    }

    // --- Fetch zone & user ---
    const [zone, user] = await Promise.all([
      getZone(
        currentOrder.pickupAddress.pinCode,
        currentOrder.receiverAddress.pinCode
      ),
      User.findById(currentOrder.userId).session(session),
    ]);

    if (!zone) {
      await Order.findByIdAndUpdate(id, { status: "new" });
      await session.abortTransaction();
      session.endSession();
      return { success: false, message: "Pincode not serviceable" };
    }

    if (!user) {
      await Order.findByIdAndUpdate(id, { status: "new" });
      await session.abortTransaction();
      session.endSession();
      return { success: false, message: "User not found" };
    }

    // Step 5️⃣ Fetch estimated delivery date from DB
    const eddData = await estimatedDeliveryDate.findOne({
      courier: "Dtdc",
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

    const currentWallet = await Wallet.findById(user.Wallet).session(session);
    if (!currentWallet) {
      await Order.findByIdAndUpdate(id, { status: "new" });
      await session.abortTransaction();
      session.endSession();
      return { success: false, message: "Wallet not found" };
    }

    // --- Wallet balance check ---
    const effectiveBalance =
      currentWallet.balance - (currentWallet.holdAmount || 0);
    const balance = effectiveBalance + currentWallet.creditLimit;
    if (balance < finalCharges) {
      await Order.findByIdAndUpdate(id, { status: "new" });
      await session.abortTransaction();
      session.endSession();
      return { success: false, message: "Insufficient Wallet Balance" };
    }

    // --- Prepare shipment payload ---
    const productNames = currentOrder.productDetails
      .map((p) => p.name)
      .join(", ");

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
          cod_collection_mode: codCollectionMode,
          cod_amount: codAmount,
          ...(courierServiceName === "Dtdc Air" && {
            commodity_id: "Others",
          }),
          reference_number: "",
        },
      ],
    };

    // --- Call DTDC API ---
    let response;
    try {
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
    } catch (err) {
      await Order.findByIdAndUpdate(id, { status: "new" });
      await session.abortTransaction();
      session.endSession();
      console.error("❌ DTDC API failed:", err.response?.data || err.message);
      return {
        success: false,
        message: err.response?.data?.message || "Shipment API failed",
        error: err.response?.data || err.message,
      };
    }

    const result = response?.data?.data?.[0];
    if (!result?.success) {
      await Order.findByIdAndUpdate(id, { status: "new" });
      await session.abortTransaction();
      session.endSession();
      return {
        success: false,
        message: result?.message || "Shipment failed",
      };
    }

    // --- Update order ---
    const balanceToBeDeducted = parseFloat(finalCharges) || 0;

    await Order.findByIdAndUpdate(
      id,
      {
        $set: {
          status: "Booked",
          cancelledAtStage: null,
          awb_number: result.reference_number,
          shipment_id: result.customer_reference_number,
          provider,
          totalFreightCharges: balanceToBeDeducted,
          courierServiceName,
          shipmentCreatedAt: new Date(),
          zone: zone.zone,
          estimatedDeliveryDate: estimateDate || "",
          priceBreakup
        },
        $push: {
          tracking: {
            status: "Booked",
            StatusLocation: currentOrder.pickupAddress?.city || "N/A",
            StatusDateTime: new Date(),
            Instructions: "Order booked successfully",
          },
        },
      },
      { session }
    );

    await session.commitTransaction();
    session.endSession();

    try {
      // --- Update wallet immediately ---
      const updatedWallet = await Wallet.findOneAndUpdate(
        { _id: user.Wallet, balance: { $gte: balanceToBeDeducted } },
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
              awb_number: result.reference_number || "",
              description: "Freight Charges Applied",
              priceBreakup
            },
          },
        },
        { new: true }
      );

      if (!updatedWallet) {
        console.warn(
          "⚠️ Wallet not updated — insufficient balance or invalid ID"
        );
      }
    } catch (err) {
      console.error("Wallet update error:", err.message);
    }

    // ── Auto-assign pickup manifest ──
    try {
      const freshOrder = await Order.findById(id);
      if (freshOrder) await assignPickupManifest(freshOrder);
    } catch (pErr) {
      console.error("[Pickup] assignPickupManifest failed:", pErr.message);
    }

    // --- Return success ---
    return {
      success: true,
      message: "Shipment Created Successfully",
      awb_number: result.reference_number,
    };
  } catch (error) {
    await Order.findByIdAndUpdate(id, { status: "new" });
    await session.abortTransaction();
    session.endSession();
    console.error("❌ Error creating DTDC shipment:", error.message);
    return {
      success: false,
      message: "Failed to create shipment",
      error: error.message,
    };
  }
};

module.exports = createDTDCShipment;
