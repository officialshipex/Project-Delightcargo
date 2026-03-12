const axios = require("axios");
const Order = require("../../models/newOrder.model");
const User = require("../../models/User.model");
const Wallet = require("../../models/wallet");
const mongoose = require("mongoose");
const plan = require("../../models/Plan.model");
const { getZone } = require("../../Rate/zoneManagementController");
const {
  createClientWarehouse,
} = require("../../AllCouriers/Delhivery/Courier/couriers.controller");
const {
  fetchBulkWaybills,
} = require("../../AllCouriers/Delhivery/Authorize/saveCourierContoller");
const url = process.env.DELHIVERY_URL;
const API_TOKEN = process.env.DEL_API_TOKEN;
const estimatedDeliveryDate = require("../../models/EDDMap.model");
const { assignPickupManifest } = require("../../Orders/scheduledPickup.controller");

const createDelhiveryShipment = async ({
  id,
  provider,
  finalCharges,
  courierServiceName,
  priceBreakup
}) => {
  const session = await mongoose.startSession();

  try {
    session.startTransaction();

    // Step 1️⃣ Fetch order & mark as processing
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

    // Step 2️⃣ Fetch user + wallet in parallel
    const [users, currentPlan] = await Promise.all([
      User.findById(currentOrder.userId).populate("Wallet").session(session),
      plan.findOne({ userId: currentOrder.userId }).session(session),
    ]);

    if (!users || !users.Wallet) {
      await Order.findByIdAndUpdate(id, { status: "new" });
      await session.abortTransaction();
      session.endSession();
      return { success: false, message: "User or Wallet not found" };
    }

    const currentWallet = users.Wallet;

    // Step 3️⃣ Fetch waybills & zone in parallel
    const [waybills, zone] = await Promise.all([
      fetchBulkWaybills(1),
      getZone(
        currentOrder.pickupAddress.pinCode,
        currentOrder.receiverAddress.pinCode
      ),
    ]);

    if (!waybills.length || !zone) {
      await Order.findByIdAndUpdate(id, { status: "new" });
      await session.abortTransaction();
      session.endSession();
      return {
        success: false,
        message: !waybills.length
          ? "No Waybill Available"
          : "Pincode not serviceable",
      };
    }

    // Step 4️⃣ Create warehouse
    const warehouseCreationResult = await createClientWarehouse(
      currentOrder.pickupAddress
    );
    if (!warehouseCreationResult.success) {
      await Order.findByIdAndUpdate(id, { status: "new" });
      await session.abortTransaction();
      session.endSession();
      return {
        success: false,
        message: "Failed to create or fetch pickup warehouse",
        details: warehouseCreationResult,
      };
    }

    // Step 5️⃣ Fetch estimated delivery date from DB
    const eddData = await estimatedDeliveryDate.findOne({
      courier: "Delhivery",
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

    // Step 6️⃣ Prepare payload
    const pickupWarehouseName =
      warehouseCreationResult.data?.name ||
      currentOrder.pickupAddress.contactName;
    const payment_type =
      currentOrder.paymentDetails.method === "COD" ? "COD" : "Pre-paid";

    const addressLine =
      currentOrder.receiverAddress.address?.substring(0, 160) ||
      "Default Warehouse";

    const payloadData = {
      pickup_location: {
        name: pickupWarehouseName,
      },
      shipments: [
        {
          Waybill: waybills[0],
          country: "India",
          city: currentOrder.receiverAddress.city,
          pin: currentOrder.receiverAddress.pinCode,
          state: currentOrder.receiverAddress.state,
          order: currentOrder.orderId,
          add: addressLine,
          payment_mode: payment_type,
          shipping_mode: "Surface",
          quantity: currentOrder.productDetails
            .reduce((sum, p) => sum + p.quantity, 0)
            .toString(),
          phone: currentOrder.receiverAddress.phoneNumber,
          products_desc: currentOrder.productDetails
            .map((p) => p.name)
            .join(", "),
          total_amount: currentOrder.paymentDetails.amount,
          name: currentOrder.receiverAddress.contactName || "Default Warehouse",
          weight: currentOrder.packageDetails.applicableWeight * 1000,
          shipment_height: currentOrder.packageDetails.volumetricWeight.height,
          shipment_width: currentOrder.packageDetails.volumetricWeight.width,
          shipment_length: currentOrder.packageDetails.volumetricWeight.length,
          cod_amount:
            payment_type === "COD"
              ? `${currentOrder.paymentDetails.amount}`
              : "0",
        },
      ],
    };

    const payload = `format=json&data=${encodeURIComponent(
      JSON.stringify(payloadData)
    )}`;

    // Step 7️⃣ Wallet check
    const walletHoldAmount = currentWallet.holdAmount || 0;
    const effectiveBalance = currentWallet.balance - walletHoldAmount;
    const balanceToBeDeducted =
      finalCharges === "N/A" ? 0 : parseInt(finalCharges);
    const balance = effectiveBalance + currentWallet.creditLimit;
    if (balance < balanceToBeDeducted) {
      await Order.findByIdAndUpdate(id, { status: "new" });
      await session.abortTransaction();
      session.endSession();
      return { success: false, message: "Insufficient Wallet Balance" };
    }

    // Step 8️⃣ Create shipment via API
    const response = await axios.post(`${url}/api/cmu/create.json`, payload, {
      headers: {
        Authorization: `Token ${API_TOKEN}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      timeout: 8000,
    });

    const result = response.data?.packages?.[0];
    if (!response.data.success || !result) {
      await Order.findByIdAndUpdate(id, { status: "new" });
      await session.abortTransaction();
      session.endSession();
      return {
        success: false,
        message: "Failed to create shipment",
        details: response.data,
      };
    }

    // Step 9️⃣ Update Order & Wallet atomically
    await Promise.all([
      Order.findByIdAndUpdate(
        id,
        {
          $set: {
            status: "Booked",
            cancelledAtStage: null,
            awb_number: result.waybill,
            shipment_id: result.refnum,
            provider,
            totalFreightCharges: balanceToBeDeducted,
            courierServiceName,
            shipmentCreatedAt: new Date(),
            zone: zone.zone,
            estimatedDeliveryDate: estimateDate,
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
      ),
      currentWallet.updateOne(
        {
          $inc: { balance: -balanceToBeDeducted },
          $push: {
            transactions: {
              channelOrderId: currentOrder.orderId || null,
              category: "debit",
              amount: balanceToBeDeducted,
              balanceAfterTransaction: currentWallet.balance - balanceToBeDeducted,
              date: new Date(),
              awb_number: result.waybill || "",
              description: "Freight Charges Applied",
              priceBreakup
            },
          },
        },
        { session }
      ),
    ]);

    await session.commitTransaction();
    session.endSession();

    // ── Auto-assign pickup manifest ──
    // try {
    //   const freshOrder = await Order.findById(id);
    //   if (freshOrder) await assignPickupManifest(freshOrder);
    // } catch (pErr) {
    //   console.error("[Pickup] assignPickupManifest failed:", pErr.message);
    // }

    return {
      success: true,
      message: "Shipment Created Successfully",
      awb_number: result.waybill,
      orderId: currentOrder.orderId,
      estimatedDeliveryDate: estimateDate,
    };
  } catch (error) {
    await Order.findByIdAndUpdate(id, { status: "new" });
    await session.abortTransaction();
    session.endSession();
    return {
      success: false,
      message: "Error creating shipment",
      error: error.message,
    };
  }
};

module.exports = createDelhiveryShipment;
