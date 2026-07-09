const FormData = require("form-data");
const Order = require("../../models/newOrder.model");
const User = require("../../models/User.model");
const Wallet = require("../../models/wallet");
const WalletTransaction = require("../../models/WalletTransaction.model");
const mongoose = require("mongoose");
const { getZone } = require("../../Rate/zoneManagementController");
const estimatedDeliveryDate = require("../../models/EDDMap.model");
const { assignPickupManifest } = require("../../Orders/scheduledPickup.controller");

const BASE_URL = process.env.NIMBUSPOST_URL || 'https://api.nimbuspost.com/v1';
const { getNimbusJsonHeaders, getNimbusGetHeaders, clearNimbusToken, nimbusAxios: axios } = require('../../AllCouriers/NimbusPost/nimbusAuth');

// ─── Helpers ──────────────────────────────────────────────────────────────────
const generateSKU = (name) => {
  const clean = (name || "PROD").replace(/[^a-zA-Z0-9]/g, "").substring(0, 5).toUpperCase();
  return `${clean}${Math.floor(1000 + Math.random() * 9000)}`;
};

const cleanPhone = (phone) => {
  const digits = (phone || "").replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
};

const ensureAddress = (addr) => {
  let clean = (addr || "").trim();
  if (clean.length < 10) {
    clean = clean + " House No 1, Main Road";
  }
  return clean;
};

const identifyProviderFromService = (serviceName) => {
  if (!serviceName) return "NimbusPost";
  const name = serviceName.toLowerCase();
  if (name.includes("delhivery")) return "Delhivery";
  if (name.includes("xpressbees")) return "Xpressbees";
  if (name.includes("shadowfax")) return "Shadowfax";
  if (name.includes("bluedart") || name.includes("blue dart")) return "Bluedart";
  if (name.includes("dtdc")) return "DTDC";
  if (name.includes("ecom express") || name.includes("ecomexpress")) return "EcomExpress";
  if (name.includes("shree maruti") || name.includes("shreemaruti")) return "Shree Maruti";
  if (name.includes("ekart")) return "Ekart";
  if (name.includes("amazon")) return "Amazon Shipping";
  return serviceName;
};

const createNimbuspostShipment = async ({
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
      return { success: false, message: "Shipment already created or order not in 'new' status." };
    }

    // Step 2️⃣ Wallet check
    if (!walletId) {
      await Order.findByIdAndUpdate(id, { status: "new" });
      await session.abortTransaction();
      session.endSession();
      return { success: false, message: "Wallet not found" };
    }

    // Step 3️⃣ Wallet Balance Check
    const effectiveBalance = walletBalance - (walletHoldAmount || 0);
    const balanceToBeDeducted = parseFloat(finalCharges) || 0;
    const totalBalance = effectiveBalance + (walletCreditLimit || 0);

    if (totalBalance < balanceToBeDeducted) {
      await Order.findByIdAndUpdate(id, { status: "new" });
      await session.abortTransaction();
      session.endSession();
      return { success: false, message: "Insufficient Wallet Balance" };
    }

    // Step 4️⃣ Get Zone
    const zone = await getZone(currentOrder.pickupAddress.pinCode, currentOrder.receiverAddress.pinCode);
    if (!zone) {
      await Order.findByIdAndUpdate(id, { status: "new" });
      await session.abortTransaction();
      session.endSession();
      return { success: false, message: "Pincode not serviceable" };
    }

    // Step 5️⃣ Fetch EDD (Estimated Delivery Date)
    const eddData = await estimatedDeliveryDate.findOne({
      courier: "NimbusPost",
      serviceName: courierServiceName.trim(),
    });

    let estimateDate = null;
    if (eddData) {
      const deliveryDays = eddData.zoneRates?.[zone.zone] || eddData[zone.zone];
      if (typeof deliveryDays === "number") {
        estimateDate = new Date();
        estimateDate.setDate(estimateDate.getDate() + deliveryDays);
      }
    }

    // Headers for NimbusPost API (fetched from auth helper)
    const getHeaders = await getNimbusGetHeaders();
    const postHeaders = await getNimbusJsonHeaders();

    // Step 7️⃣ Fetch Courier Service doc to get courier_id
    // NimbusPost is a partner/aggregator — the actual courier (e.g. Delhivery, BlueDart)
    // is identified by courier_id stored in the CourierService record.
    // If courier_id is empty, NimbusPost's allocation engine auto-selects the courier.
    let providerCourierId = "";
    let finalProvider = "NimbusPost";
    try {
      const CourierServiceModel = require("../../models/CourierService.Schema");
      const courierService = await CourierServiceModel.findOne({
        name: courierServiceName,
        provider: "NimbusPost",
      });
      // console.log("NimbusPost CourierService lookup:", courierServiceName, "->", courierService);
      if (courierService) {
        if (courierService.courier_id) {
          providerCourierId = String(courierService.courier_id);
          console.log("Using NimbusPost courier_id:", providerCourierId);
        }
        if (courierService.courierName) {
          finalProvider = courierService.courierName;
        } else if (courierService.courier) {
          finalProvider = identifyProviderFromService(courierService.courier);
        }
      }
    } catch (dbErr) {
      console.error("Error fetching CourierService details from DB:", dbErr.message);
    }

    if (finalProvider === "NimbusPost") {
      finalProvider = identifyProviderFromService(courierServiceName);
    }


    // Step 8️⃣ Prepare NimbusPost shipment creation payload
    const isCOD = currentOrder.paymentDetails.method === "COD";
    const orderItems = currentOrder.productDetails.map((p) => ({
      name: p.name || "Product",
      qty: String(p.quantity || 1),
      price: String(p.unitPrice || 0),
      sku: p.sku || generateSKU(p.name),
    }));

    // New API uses flat structure (no nested order:{} object)
    const nimbusPayload = {
      order_number: String(currentOrder.orderId),
      shipping_charges: 0,
      discount: 0,
      cod_charges: 0,
      payment_type: isCOD ? "cod" : "prepaid",
      order_amount: currentOrder.paymentDetails.amount,
      package_weight: Math.round((currentOrder.packageDetails.applicableWeight || 0.5) * 1000), // in grams
      package_length: currentOrder.packageDetails.volumetricWeight?.length || 10,
      package_height: currentOrder.packageDetails.volumetricWeight?.height || 10,
      package_breadth: currentOrder.packageDetails.volumetricWeight?.width || 10,
      request_auto_pickup: "yes",
      consignee: {
        name: currentOrder.receiverAddress.contactName || "Receiver",
        address: ensureAddress(currentOrder.receiverAddress.address),
        address_2: ".",
        city: currentOrder.receiverAddress.city,
        state: currentOrder.receiverAddress.state,
        pincode: String(currentOrder.receiverAddress.pinCode),
        phone: cleanPhone(currentOrder.receiverAddress.phoneNumber),
      },
      pickup: {
        warehouse_name: `WH${String(currentOrder.pickupAddress.pinCode)}`,
        name: currentOrder.pickupAddress.contactName || "Pickup Contact",
        address: ensureAddress(currentOrder.pickupAddress.address),
        address_2: currentOrder.pickupAddress.landmark || ".",
        city: currentOrder.pickupAddress.city,
        state: currentOrder.pickupAddress.state,
        pincode: String(currentOrder.pickupAddress.pinCode),
        phone: cleanPhone(currentOrder.pickupAddress.phoneNumber),
      },
      order_items: orderItems,
    };

    if (providerCourierId) {
      nimbusPayload.courier_id = providerCourierId;
    }

    console.log("NimbusPost Create Shipment Payload:", JSON.stringify(nimbusPayload, null, 2));

    // Step 9️⃣ Call Create Shipment API — new endpoint is POST /shipments (not /shipments/create)
    const createResponse = await axios.post(`${BASE_URL}/shipments`, nimbusPayload, {
      headers: postHeaders,
      timeout: 20000,
    });

    console.log("NimbusPost Create Response:", createResponse.data);

    if (!createResponse.data?.status || !createResponse.data.data?.awb_number) {
      await Order.findByIdAndUpdate(id, { status: "new" });
      await session.abortTransaction();
      session.endSession();
      return { success: false, message: createResponse.data?.message || "NimbusPost order creation failed" };
    }

    const { awb_number, shipment_id, courier_name, label } = createResponse.data.data;
    const resolvedProvider = identifyProviderFromService(courier_name || finalProvider);

    // Step 1️⃣1️⃣ Update Order and Wallet details
    await Promise.all([
      Order.findByIdAndUpdate(
        id,
        {
          $set: {
            status: "Booked",
            awb_number: awb_number,
            shipment_id: String(shipment_id),
            provider: resolvedProvider,
            partner: "NimbusPost",
            totalFreightCharges: balanceToBeDeducted,
            courierServiceName,
            shipmentCreatedAt: new Date(),
            zone: zone.zone,
            estimatedDeliveryDate: estimateDate,
            priceBreakup,
            label: label || "",
          },
          $push: {
            tracking: {
              status: "Booked",
              StatusLocation: currentOrder.pickupAddress?.city || "N/A",
              StatusDateTime: new Date(Date.now() + 5.5 * 60 * 60 * 1000),
              Instructions: "Order booked successfully",
            },
          },
        },
        { session }
      ),
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
            awb_number: awb_number,
            description: "Freight Charges Applied",
            priceBreakup,
          }
        ],
        { session }
      )
    ]);

    await session.commitTransaction();
    session.endSession();

    // Trigger background pickup manifest assignment
    process.nextTick(async () => {
      try {
        const fresh = await Order.findById(id);
        if (fresh) await assignPickupManifest(fresh);
      } catch (e) {
        console.error("NimbusPost Pickup Assign Error:", e.message);
      }
    });

    return {
      success: true,
      message: "Shipment Created Successfully",
      awb_number,
      labelUrl: label || null,
    };
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction();
    await Order.findByIdAndUpdate(id, { status: "new" });
    session.endSession();
    console.error("NimbusPost Shipment Creation Error:", error.response?.data || error.message);
    return {
      success: false,
      message: "Error creating shipment",
      error: error.response?.data?.message || error.message,
    };
  }
};

module.exports = createNimbuspostShipment;
