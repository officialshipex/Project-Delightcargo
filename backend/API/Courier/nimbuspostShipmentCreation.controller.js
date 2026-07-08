const axios = require("axios");
const FormData = require("form-data");
const Order = require("../../models/newOrder.model");
const User = require("../../models/User.model");
const Wallet = require("../../models/wallet");
const WalletTransaction = require("../../models/WalletTransaction.model");
const mongoose = require("mongoose");
const { getZone } = require("../../Rate/zoneManagementController");
const estimatedDeliveryDate = require("../../models/EDDMap.model");
const { assignPickupManifest } = require("../../Orders/scheduledPickup.controller");

const BASE_URL = process.env.NIMBUSPOST_URL || "https://ship.nimbuspost.com/api";
const API_KEY = process.env.NIMBUS_API_KEY;

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

    // Headers for NimbusPost API
    // NOTE: GET requests must NOT include Content-Type — NimbusPost rejects it
    const getHeaders = {
      "NP-API-KEY": API_KEY,
    };
    const postHeaders = {
      "Content-Type": "application/json",
      "NP-API-KEY": API_KEY,
    };

    // Step 6️⃣ Get or Create Warehouse in NimbusPost
    let pickupWarehouseId = "";
    try {
      // Fetch all warehouses — use getHeaders (no Content-Type)
      const warehouseResponse = await axios.get(`${BASE_URL}/warehouse`, {
        headers: getHeaders,
        timeout: 10000,
      });

      const existingWarehouses = warehouseResponse.data?.data || [];
      const orderPin = String(currentOrder.pickupAddress.pinCode);
      const orderAddr = (currentOrder.pickupAddress.address || "").toLowerCase();

      // Find match
      const match = existingWarehouses.find((wh) => {
        const whPin = String(wh.zip || wh.pincode || wh.pin_code || "");
        const whAddr = (wh.address_1 || wh.address || "").toLowerCase();
        return whPin === orderPin && (orderAddr.includes(whAddr.substring(0, 10)) || whAddr.includes(orderAddr.substring(0, 10)));
      }) || existingWarehouses.find((wh) => String(wh.zip || wh.pincode || wh.pin_code || "") === orderPin);

      if (match) {
        pickupWarehouseId = String(match.id);
        console.log("Matched existing NimbusPost warehouse ID:", pickupWarehouseId);
      } else {
        console.log("No matching warehouse found for pincode:", orderPin, ". Creating new warehouse.");

        // NimbusPost warehouse/create requires multipart/form-data (not JSON)
        // Name must be alphanumeric + spaces only (no hyphens, special chars), max 20 chars
        const whName = `${currentOrder.pickupAddress.contactName || "WH"} ${orderPin}`
          .replace(/[^a-zA-Z0-9 ]/g, "")
          .substring(0, 20)
          .trim();
        const whForm = new FormData();
        whForm.append("name", whName);
        whForm.append("contact_name", currentOrder.pickupAddress.contactName || "Warehouse Contact");
        whForm.append("phone", cleanPhone(currentOrder.pickupAddress.phoneNumber));
        whForm.append("address_1", ensureAddress(currentOrder.pickupAddress.address));
        whForm.append("address_2", currentOrder.pickupAddress.landmark || "N/A");
        whForm.append("city", currentOrder.pickupAddress.city);
        whForm.append("state", currentOrder.pickupAddress.state);
        whForm.append("zip", orderPin);

        const createWhResponse = await axios.post(`${BASE_URL}/warehouse/create`, whForm, {
          headers: {
            "NP-API-KEY": API_KEY,
            ...whForm.getHeaders(),
          },
          timeout: 10000,
        });

        if (createWhResponse.data?.status) {
          pickupWarehouseId = String(createWhResponse.data.data?.id || createWhResponse.data.data);
          console.log("Created new NimbusPost warehouse ID:", pickupWarehouseId);
        } else {
          throw new Error(createWhResponse.data?.message || "Failed to create warehouse in NimbusPost response");
        }
      }
    } catch (e) {
      console.error("NimbusPost Warehouse Sync Error:", e.response?.data || e.message);
      await Order.findByIdAndUpdate(id, { status: "new" });
      await session.abortTransaction();
      session.endSession();
      return { success: false, message: `NimbusPost Warehouse Sync Error: ${e.response?.data?.message || e.message}` };
    }

    if (!pickupWarehouseId) {
      await Order.findByIdAndUpdate(id, { status: "new" });
      await session.abortTransaction();
      session.endSession();
      return { success: false, message: "Failed to resolve or create warehouse in NimbusPost." };
    }

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

    const nimbusPayload = {
      consignee: {
        name: currentOrder.receiverAddress.contactName || "Receiver",
        address: ensureAddress(currentOrder.receiverAddress.address),
        address_2: ".",
        city: currentOrder.receiverAddress.city,
        state: currentOrder.receiverAddress.state,
        pincode: String(currentOrder.receiverAddress.pinCode),
        phone: cleanPhone(currentOrder.receiverAddress.phoneNumber),
      },
      order: {
        order_number: String(currentOrder.orderId),
        shipping_charges: 0,
        discount: 0,
        cod_charges: 0,
        payment_type: isCOD ? "cod" : "prepaid",
        total: currentOrder.paymentDetails.amount,
        package_weight: Math.round((currentOrder.packageDetails.applicableWeight || 0.5) * 1000), // in grams
        package_length: currentOrder.packageDetails.volumetricWeight?.length || 10,
        package_height: currentOrder.packageDetails.volumetricWeight?.height || 10,
        package_breadth: currentOrder.packageDetails.volumetricWeight?.width || 10,
      },
      order_items: orderItems,
      pickup_warehouse_id: pickupWarehouseId,
      rto_warehouse_id: pickupWarehouseId,
    };

    if (providerCourierId) {
      nimbusPayload.courier_id = providerCourierId;
    }

    console.log("NimbusPost Create Shipment Payload:", JSON.stringify(nimbusPayload, null, 2));

    // Step 9️⃣ Call Create Shipment API
    const createResponse = await axios.post(`${BASE_URL}/shipments/create`, nimbusPayload, {
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

    const { awb_number, shipment_id, courier_name } = createResponse.data.data;
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
            label: "",
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

    // Trigger background pickup request
    process.nextTick(async () => {
      try {
        await axios.post(
          `${BASE_URL}/shipments/pickups`,
          JSON.stringify({ ids: [shipment_id] }),
          {
            headers: {
              "Content-Type": "application/json",
              "NP-API-KEY": API_KEY,
            },
          }
        );
        const fresh = await Order.findById(id);
        if (fresh) await assignPickupManifest(fresh);
      } catch (e) {
        console.error("NimbusPost Pickup Request Error:", e.response?.data || e.message);
      }
    });

    return {
      success: true,
      message: "Shipment Created Successfully",
      awb_number,
      labelUrl: labelUrl || null,
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
