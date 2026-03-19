const axios = require("axios");
const Order = require("../../../models/newOrder.model");
const Wallet = require("../../../models/wallet");
const pickupAddress = require("../../../models/pickupAddress.model");
const { getZone } = require("../../../Rate/zoneManagementController");
const { getAccessToken } = require("../Authorize/Ekart.controller");
const {
  calculateGSTForItems,
  addEkartAddress,
} = require("./couriers.controller");
const { assignPickupManifest } = require("../../../Orders/scheduledPickup.controller");

const createOrderEkart = async (
  serviceDetails,
  orderId,
  wh,
  walletId,
  charges,
  estimatedDeliveryDate = null,
  priceBreakup
) => {
  try {
    /* --------------------------------------------------
       1️⃣ FETCH ORDER
    -------------------------------------------------- */
    const currentOrder = await Order.findById(orderId);
    if (!currentOrder) {
      return { success: false, message: "Order not found" };
    }

    /* --------------------------------------------------
       2️⃣ ZONE CHECK
    -------------------------------------------------- */
    const zone = await getZone(
      currentOrder.pickupAddress.pinCode,
      currentOrder.receiverAddress.pinCode,
    );

    if (!zone) {
      return { success: false, message: "Pincode not serviceable" };
    }

    /* --------------------------------------------------
       3️⃣ WALLET CHECK (DTDC STYLE)
    -------------------------------------------------- */
    const currentWallet = await Wallet.findById(walletId);
    if (!currentWallet) {
      return { success: false, message: "Wallet not found" };
    }

    const holdAmount = currentWallet.holdAmount || 0;
    const effectiveBalance = currentWallet.balance - holdAmount;
    const balance = effectiveBalance + currentWallet.creditLimit;

    if (balance < charges) {
      return { success: false, message: "Insufficient Wallet Balance" };
    }

    /* --------------------------------------------------
       4️⃣ PICKUP ADDRESS + EKART ALIAS
    -------------------------------------------------- */
    const pickup = await pickupAddress.findOne({
      "pickupAddress.contactName": currentOrder.pickupAddress.contactName,
      "pickupAddress.address": currentOrder.pickupAddress.address,
      "pickupAddress.pinCode": currentOrder.pickupAddress.pinCode,
    });

    if (!pickup) {
      return { success: false, message: "Pickup address not found" };
    }

    const accessToken = await getAccessToken();
    if (!accessToken) {
      return { success: false, message: "Failed to get Ekart access token" };
    }

    let ekartAlias = pickup.ekartAlias;

    if (!ekartAlias) {
      const addressPayload = {
        alias: `WAREHOUSE_${Date.now()}`,
        phone: pickup.pickupAddress.phoneNumber,
        address_line1: pickup.pickupAddress.address,
        address_line2: "",
        pincode: pickup.pickupAddress.pinCode,
        city: pickup.pickupAddress.city,
        state: pickup.pickupAddress.state,
        country: "IN",
        geo: { lat: 0, lon: 0 },
      };

      const addResult = await addEkartAddress(addressPayload, accessToken);
      if (!addResult.success) {
        return {
          success: false,
          message: "Failed to register pickup address with Ekart",
          error: addResult.error,
        };
      }

      ekartAlias = addResult.alias;

      await pickupAddress.updateOne({ _id: pickup._id }, { ekartAlias });
    }

    /* --------------------------------------------------
       5️⃣ GST CALCULATION
    -------------------------------------------------- */
    const { updatedItems, totalTaxValue } = calculateGSTForItems(
      currentOrder.productDetails,
      pickup.pickupAddress.state.trim(),
      currentOrder.receiverAddress.state.trim(),
      process.env.SELLER_GST_TIN || "",
    );

    /* --------------------------------------------------
       6️⃣ EKART PAYLOAD
    -------------------------------------------------- */
    const isCOD = currentOrder.paymentDetails.method === "COD";
    const todayStr = new Date().toISOString().split("T")[0];
    const productsDesc = updatedItems.map((p) => p.name).join(", ") || "Goods";
    const cleanItems = updatedItems.map((i) => (i.toObject ? i.toObject() : i));

    const totalQty = cleanItems.reduce(
      (sum, i) => sum + (i._doc.quantity || 0),
      0,
    );

    const items = cleanItems.map((p) => ({
      product_name: p._doc.name,
      sku: p._doc.sku,
      taxable_value: p.taxable_value,
      cgst_tax_value: p.cgst_tax_value,
      sgst_tax_value: p.sgst_tax_value,
      igst_tax_value: p.igst_tax_value,
      quantity: p._doc.quantity,
      description: p._doc.name,
      length:
        p.length || currentOrder.packageDetails.volumetricWeight.length || 0,
      height:
        p.height || currentOrder.packageDetails.volumetricWeight.height || 0,
      breadth:
        p.width || currentOrder.packageDetails.volumetricWeight.width || 0,
      weight: p.weight || currentOrder.packageDetails.applicableWeight || 1,
      hsn_code: p._doc?.hsnCode || "",
    }));

    const payload = {
      seller_name: pickup.pickupAddress.contactName,
      seller_address: pickup.pickupAddress.address,
      seller_gst_tin: process.env.SELLER_GST_TIN || "",

      order_number: String(currentOrder.orderId),
      invoice_number: String(currentOrder.orderId),
      invoice_date: todayStr,
      consignee_gst_amount: totalTaxValue,
      consignee_name: currentOrder.receiverAddress.contactName,
      products_desc: productsDesc,
      payment_mode: isCOD ? "COD" : "Prepaid",
      cod_amount: isCOD ? currentOrder.paymentDetails.amount : 0,

      total_amount: currentOrder.paymentDetails.amount,
      tax_value: totalTaxValue,
      taxable_amount: currentOrder.paymentDetails.amount,
      commodity_value: String(
        currentOrder.paymentDetails.amount - totalTaxValue,
      ),
      quantity: totalQty,
      weight: currentOrder.packageDetails.applicableWeight,
      length: currentOrder.packageDetails.volumetricWeight.length,
      height: currentOrder.packageDetails.volumetricWeight.height,
      width: currentOrder.packageDetails.volumetricWeight.width,

      pickup_location: { name: ekartAlias },
      return_location: { name: ekartAlias },

      drop_location: {
        address: currentOrder.receiverAddress.address,
        city: currentOrder.receiverAddress.city,
        state: currentOrder.receiverAddress.state,
        country: "IN",
        name: currentOrder.receiverAddress.contactName,
        phone: Number(currentOrder.receiverAddress.phoneNumber),
        pin: Number(currentOrder.receiverAddress.pinCode),
      },

      items,
    };

    /* --------------------------------------------------
       7️⃣ EKART API CALL
    -------------------------------------------------- */
    const response = await axios.put(
      "https://app.elite.ekartlogistics.in/api/v1/package/create",
      payload,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 15000,
      },
    );

    if (!response?.data?.status) {
      return {
        success: false,
        message: response.data?.message || "Ekart shipment failed",
        error: response.data,
      };
    }

    const awb = response.data.tracking_id;

    /* --------------------------------------------------
       8️⃣ UPDATE ORDER (DTDC STYLE)
    -------------------------------------------------- */
    currentOrder.status = "Booked";
    currentOrder.cancelledAtStage = null;
    currentOrder.awb_number = awb;
    currentOrder.shipment_id = String(currentOrder.orderId);
    currentOrder.provider = serviceDetails.provider;
    currentOrder.totalFreightCharges = parseFloat(charges);
    currentOrder.courierServiceName = serviceDetails.name;
    currentOrder.shipmentCreatedAt = new Date();
    currentOrder.zone = zone.zone;
    currentOrder.estimatedDeliveryDate = estimatedDeliveryDate;
    currentOrder.priceBreakup = priceBreakup;

    currentOrder.tracking.push({
      status: "Booked",
      StatusLocation: currentOrder.pickupAddress.city || "N/A",
      StatusDateTime: new Date(Date.now() + 5.5 * 60 * 60 * 1000),
      Instructions: "Order booked successfully",
    });

    await currentOrder.save();

    // ── Auto-assign pickup manifest ──
    try {
      await assignPickupManifest(currentOrder);
    } catch (pErr) {
      console.error("[Pickup] assignPickupManifest failed:", pErr.message);
    }

    /* --------------------------------------------------
       9️⃣ WALLET DEBIT (DTDC STYLE)
    -------------------------------------------------- */
    await Wallet.findOneAndUpdate(
      { _id: walletId },
      {
        $inc: { balance: -charges },
        $push: {
          transactions: {
            channelOrderId: currentOrder.orderId,
            category: "debit",
            amount: charges,
            balanceAfterTransaction:
              currentWallet.balance - parseFloat(charges),
            date: new Date(),
            awb_number: awb,
            description: "Freight Charges Applied",
            priceBreakup
          },
        },
      },
      { new: true },
    );

    /* --------------------------------------------------
       10️⃣ FINAL RETURN (SAME AS DTDC)
    -------------------------------------------------- */
    return {
      success: true,
      message: "Shipment Created Successfully",
      orderId: currentOrder.orderId,
      waybill: awb,
    };
  } catch (error) {
    console.error(
      "Ekart shipment error:",
      error.response?.data || error.message,
    );
    return {
      success: false,
      message: "Failed to create shipment",
      error: error.response?.data || error.message,
    };
  }
};

module.exports = { createOrderEkart };
