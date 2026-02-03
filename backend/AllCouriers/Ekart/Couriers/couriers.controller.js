const axios = require("axios");
const { getAccessToken } = require("../Authorize/Ekart.controller"); // import your token function
const Order = require("../../../models/newOrder.model");
const { getZone } = require("../../../Rate/zoneManagementController");
const User = require("../../../models/User.model");
const Wallet = require("../../../models/wallet");
const mongoose = require("mongoose");
const pickupAddress = require("../../../models/pickupAddress.model");

// =====================================================
// ⭐ SEPARATE GST CALCULATION FUNCTION
// =====================================================
function calculateGSTForItems(
  orderItems,
  sellerState,
  buyerState,
  sellerGSTIN,
) {
  const defaultGST = 18; // default GST if seller has no GSTIN
  const isInterState = sellerState !== buyerState;

  let totalTaxValue = 0;

  const updatedItems = orderItems.map((item) => {
    const price = (item.unitPrice || 0) * (item.quantity || 1);
    const gstRate = item.gstRate || defaultGST;

    const taxAmount = (price * gstRate) / 100;
    totalTaxValue += taxAmount;

    let cgst = 0,
      sgst = 0,
      igst = 0;

    if (isInterState) {
      igst = taxAmount;
    } else {
      cgst = taxAmount / 2;
      sgst = taxAmount / 2;
    }

    return {
      ...item,
      taxable_value: price,
      cgst_tax_value: cgst,
      sgst_tax_value: sgst,
      igst_tax_value: igst,
    };
  });

  return { updatedItems, totalTaxValue };
}

// =====================================================
// ⭐ MAIN FUNCTION
// =====================================================
const orderCreationEkart = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    const { id, finalCharges, courierServiceName, provider,estimatedDeliveryDate } = req.body;
    // console.log("Received orderCreationEkart request:", req.body);

    const accessToken = await getAccessToken();
    // console.log("Fetched Ekart access token:", accessToken);
    if (!accessToken) {
      return res.status(500).json({
        success: false,
        message: "Failed to get Ekart access token",
      });
    }

    session.startTransaction();

    // 1. Lock order
    const currentOrder = await Order.findOneAndUpdate(
      { _id: id, status: "new" },
      { $set: { status: "processing" } },
      { new: true, session },
    );
    if (!currentOrder) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: "Order not in 'new' status.",
      });
    }

    // 2. Zone Check
    const zone = await getZone(
      currentOrder.pickupAddress.pinCode,
      currentOrder.receiverAddress.pinCode,
    );
    if (!zone) {
      await Order.findByIdAndUpdate(id, { status: "new" });
      await session.abortTransaction();
      session.endSession();
      return res
        .status(400)
        .json({ success: false, message: "Pincode not serviceable" });
    }

    // 3. Fetch Wallet
    const user = await User.findById(currentOrder.userId).session(session);
    const currentWallet = await Wallet.findById(user.Wallet).session(session);
    const holdAmount = currentWallet.holdAmount || 0;
    const effectiveBalance = currentWallet.balance - holdAmount;

    const balance = effectiveBalance + currentWallet.creditLimit;
    if (balance < finalCharges) {
      await Order.findByIdAndUpdate(id, { status: "new" });
      await session.abortTransaction();
      session.endSession();
      return res
        .status(400)
        .json({ success: false, message: "Insufficient Wallet Balance" });
    }

    // 4. Fetch pickup address FROM pickupAddress collection
    const pickup = await pickupAddress
      .findOne({
        "pickupAddress.contactName": currentOrder.pickupAddress.contactName,
        "pickupAddress.address": currentOrder.pickupAddress.address,
        "pickupAddress.pinCode": currentOrder.pickupAddress.pinCode,
      })
      .session(session);
// console.log("Fetched pickup address:", pickup);
    if (!pickup) {
      await Order.findByIdAndUpdate(id, { status: "new" });
      await session.abortTransaction();
      session.endSession();
      return res
        .status(400)
        .json({ success: false, message: "Pickup address not found" });
    }

    let ekartAlias = pickup.ekartAlias;

    // 5. Register pickup address with Ekart (if alias missing)
    if (!ekartAlias) {
      // console.log("Registering pickup address with Ekart...");

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
      // console.log("Ekart Add Address Result:", addResult);

      if (!addResult.success) {
        await Order.findByIdAndUpdate(id, { status: "new" });
        await session.abortTransaction();
        session.endSession();
        return res.status(500).json({
          success: false,
          message: "Failed to register pickup address with Ekart",
          error: addResult.error,
        });
      }

      ekartAlias = addResult.alias;

      await pickupAddress.updateOne(
        {
          "pickupAddress.contactName": pickup.pickupAddress.contactName,
          "pickupAddress.address": pickup.pickupAddress.address,
          "pickupAddress.pinCode": pickup.pickupAddress.pinCode,
        },
        { ekartAlias },
        { session },
      );

      // console.log("Ekart alias saved:", ekartAlias);
    }

    // =====================================================
    // ⭐ 6. GST CALCULATION USING SEPARATE FUNCTION
    // =====================================================

    const sellerState = pickup.pickupAddress.state.trim();
    const buyerState = currentOrder.receiverAddress.state.trim();
    const sellerGSTIN = process.env.SELLER_GST_TIN || "";

    const { updatedItems, totalTaxValue } = calculateGSTForItems(
      currentOrder.productDetails,
      sellerState,
      buyerState,
      sellerGSTIN,
    );

    // =====================================================
    // ⭐ 7. BUILD EKART PAYLOAD
    // =====================================================

    const todayStr = new Date().toISOString().split("T")[0];
    const isCOD = currentOrder.paymentDetails.method === "COD";
    // console.log("Updated Items with GST:", updatedItems);

    const productsDesc = updatedItems.map((p) => p.name).join(", ") || "Goods";
    const cleanItems = updatedItems.map((i) => (i.toObject ? i.toObject() : i));

    const totalQuantity = cleanItems.reduce(
      (sum, p) => sum + (p._doc.quantity || 0),
      0,
    );
    // console.log("Clean Items for Ekart Payload:", cleanItems);
    const firstProduct = cleanItems[0] || {};

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

      total_amount: currentOrder.paymentDetails.amount,
      _taxable_amount: currentOrder.paymentDetails.amount,
      tax_value: totalTaxValue,
      taxable_amount: currentOrder.paymentDetails.amount,
      commodity_value: String(
        currentOrder.paymentDetails.amount - totalTaxValue,
      ),
      cod_amount: isCOD ? currentOrder.paymentDetails.amount : 0,

      quantity: totalQuantity,

      weight: currentOrder.packageDetails.applicableWeight,
      length: currentOrder.packageDetails.volumetricWeight.length,
      height: currentOrder.packageDetails.volumetricWeight.height,
      width: currentOrder.packageDetails.volumetricWeight.width,

      drop_location: {
        location_type: "Office",
        address: currentOrder.receiverAddress.address,
        city: currentOrder.receiverAddress.city,
        state: currentOrder.receiverAddress.state,
        country: "IN",
        name: currentOrder.receiverAddress.contactName,
        phone: Number(currentOrder.receiverAddress.phoneNumber),
        pin: Number(currentOrder.receiverAddress.pinCode),
      },

      pickup_location: { name: ekartAlias },
      return_location: { name: ekartAlias },

      qc_details: {
        qc_shipment: true,
        product_name: firstProduct._doc?.name,
        product_desc: firstProduct._doc?.name,
        product_sku: firstProduct._doc?.sku,
        product_images: firstProduct._doc?.images || [],
      },

      items,
      what3words_address: "",
    };

    // =====================================================
    // ⭐ 8. EKART API CALL
    // =====================================================
    // console.log("Ekart Shipment Payload:", payload);
    let response;

    try {
      response = await axios.put(
        "https://app.elite.ekartlogistics.in/api/v1/package/create",
        payload,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          timeout: 15000, // ✅ REQUIRED
        },
      );

      console.log("Ekart Shipment Response:", response.data);
    } catch (err) {
      console.log("Ekart Shipment Error:", err.response?.data || err.message);

      // ✅ SEND RESPONSE IMMEDIATELY
      res.status(500).json({
        success: false,
        message:
          err.code === "ECONNABORTED"
            ? "Ekart timeout"
            : err.response?.data?.description || "Ekart Shipment Failed",
        error: err.response?.data || err.message,
      });

      // ✅ CLEANUP ASYNC (do NOT block response)
      process.nextTick(async () => {
        try {
          await Order.findByIdAndUpdate(id, { status: "new" });
          await session.abortTransaction();
          session.endSession();
        } catch (e) {
          console.error("Cleanup error:", e);
        }
      });

      return;
    }

    if (!response?.data?.status) {
      await Order.findByIdAndUpdate(id, { status: "new" });
      await session.abortTransaction();
      session.endSession();
      return res
        .status(400)
        .json({ success: false, message: response.data?.message });
    }

    // =====================================================
    // ⭐ 9. UPDATE ORDER AFTER SUCCESS
    // =====================================================

    const balanceToBeDeducted = parseFloat(finalCharges);

    await Order.findByIdAndUpdate(
      id,
      {
        $set: {
          status: "Booked",
          awb_number: response.data.tracking_id,
          shipment_id: currentOrder.orderId,
          provider,
          courierServiceName,
          totalFreightCharges: balanceToBeDeducted,
          shipmentCreatedAt: new Date(),
          zone: zone.zone,
          estimatedDeliveryDate: estimatedDeliveryDate || null,
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
      { session },
    );

    await session.commitTransaction();
    session.endSession();

    res.status(200).json({
      success: true,
      message: "Shipment Created Successfully",
      awb: response.data.tracking_id,
    });

    // =====================================================
    // ⭐ 10. WALLET UPDATE ASYNC
    // =====================================================
    process.nextTick(async () => {
      try {
        await Wallet.findOneAndUpdate(
          { _id: user.Wallet },
          {
            $inc: { balance: -balanceToBeDeducted },
            $push: {
              transactions: {
                channelOrderId: currentOrder.orderId,
                category: "debit",
                amount: balanceToBeDeducted,
                balanceAfterTransaction:
                  currentWallet.balance - balanceToBeDeducted,
                date: new Date(),
                awb_number: response.data.tracking_id,
                description: "Freight Charges Applied",
              },
            },
          },
        );
      } catch (err) {
        console.error("Wallet update error:", err);
      }
    });
  } catch (err) {
    await Order.findByIdAndUpdate(req.body.id, { status: "new" });
    await session.abortTransaction();
    session.endSession();

    return res.status(500).json({
      success: false,
      message: "Failed to create shipment",
      error: err.message,
    });
  }
};

async function addEkartAddress(address, accessToken) {
  try {
    if (!accessToken) throw new Error("Failed to get Ekart access token");

    // -------------------------------------------------------
    // INLINE: FIX address_line1 IF LENGTH < 10 CHARACTERS
    // -------------------------------------------------------
    let line1 = (address.address_line1 || "").trim();
    let line2 = address.address_line2 || "";

    // If short → append city + state
    if (line1.length < 10) {
      line1 = `${line1} ${address.city} ${address.state}`.trim();
    }

    // If still short (rare), pad with spaces
    if (line1.length < 10) {
      line1 = line1.padEnd(10, " ");
    }
    // -------------------------------------------------------

    const payload = {
      alias: address.alias,
      phone: Number(address.phone),
      address_line1: line1,
      address_line2: line2,
      pincode: Number(address.pincode),
      city: address.city,
      state: address.state,
      country: address.country,
      geo: address.geo || { lat: 0, lon: 0 },
    };

    console.log("Ekart Address Payload:", payload);

    const response = await axios.post(
      "https://app.elite.ekartlogistics.in/api/v2/address",
      payload,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      },
    );

    console.log("Ekart Address Response:", response.data);

    return {
      success: true,
      alias: response.data?.alias,
      remark: response.data?.remark,
    };
  } catch (err) {
    console.error(
      "Ekart Add Address Error:",
      err.response?.data || err.message,
    );

    return {
      success: false,
      message: err.response?.data?.message || "Failed to add address",
      error: err.response?.data || err.message,
    };
  }
}

const cancelShipmentEkart = async (tracking_id) => {
  try {
    if (!tracking_id) {
      return {
        success: false,
        error: "tracking_id query parameter is required",
      };
    }

    const isCancelled = await Order.findOne({
      awb_number: tracking_id,
      status: "Cancelled",
    });
    if (isCancelled) {
      console.log("Order is already cancelled");
      return {
        error: "Order is already cancelled",
        code: 400,
      };
    }

    // Fetch valid access token
    const accessToken = await getAccessToken();
    if (!accessToken) {
      return { success: false, error: "Failed to get access token" };
    }

    // Call Ekart cancel shipment API
    const ekartCancelUrl = `https://app.elite.ekartlogistics.in/api/v1/package/cancel?tracking_id=${encodeURIComponent(
      tracking_id,
    )}`;

    const response = await axios.delete(ekartCancelUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    });

    // Log response for debugging
    console.log("Ekart Cancel Shipment Response:", response.data);

    if (response.status === 200 && response.data.status === true) {
      // await Order.updateOne(
      //   { awb_number: tracking_id },
      //   { $set: { status: "Cancelled" } }
      // );

      return {
        data: response.data,
        code: 201,
      };
    } else {
      // If API response says cancellation failed

      return {
        error: "Error in shipment cancellation",
        details: response.data,
        code: 400,
      };
    }
  } catch (error) {
    console.error(
      "Error cancelling shipment with Ekart:",
      error.response?.data || error.message || error,
    );
    return {
      success: false,
      message: "Internal server error while cancelling shipment",
      error: error.response?.data || error.message,
    };
  }
};

const checkEkartServiceability = async (pickupPincode, receiverPincode) => {
  try {
    const token = await getAccessToken();
    if (!token) {
      return { success: false, message: "Failed to fetch access token" };
    }

    const headers = {
      Authorization: `Bearer ${token}`,
    };

    // Make both requests in parallel
    const [pickupResponse, receiverResponse] = await Promise.all([
      axios.get(
        `https://app.elite.ekartlogistics.in/api/v2/serviceability/${pickupPincode}`,
        { headers },
      ),
      axios.get(
        `https://app.elite.ekartlogistics.in/api/v2/serviceability/${receiverPincode}`,
        { headers },
      ),
    ]);

    const pickupData = pickupResponse.data;
    const receiverData = receiverResponse.data;

    // console.log("Ekart Serviceability Pickup Data:", pickupData);
    // console.log("Ekart Serviceability Receiver Data:", receiverData);

    // Check serviceability from 'status' field instead of data.is_serviceable
    const pickupServiceable = pickupData?.status === true;
    const receiverServiceable = receiverData?.status === true;

    const serviceable = pickupServiceable && receiverServiceable;

    return {
      success: serviceable,
      data: {
        pickup: pickupData?.details || {},
        receiver: receiverData?.details || {},
      },
    };
  } catch (error) {
    console.error(
      "Ekart Serviceability Error:",
      error.response?.data || error.message,
    );
    return {
      success: false,
      error: error.response?.data || error.message,
    };
  }
};

module.exports = {
  checkEkartServiceability,
  orderCreationEkart,
  cancelShipmentEkart,
  calculateGSTForItems,
  addEkartAddress
};
