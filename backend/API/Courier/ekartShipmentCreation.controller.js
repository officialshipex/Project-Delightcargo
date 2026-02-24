const axios = require("axios");
const Order = require("../../models/newOrder.model");
const User = require("../../models/User.model");
const Wallet = require("../../models/wallet");
const { getZone } = require("../../Rate/zoneManagementController");
const estimatedDeliveryDate = require("../../models/EDDMap.model");
const mongoose = require("mongoose");
const {getAccessToken}=require("../../AllCouriers/Ekart/Authorize/Ekart.controller")
const pickupAddress=require("../../models/pickupAddress.model");
const { calculateGSTForItems,addEkartAddress } = require("../../AllCouriers/Ekart/Couriers/couriers.controller");


const createEkartShipment = async ({
  id,
  provider,
  finalCharges,
  courierServiceName,
  priceBreakup
}) => {
  const session = await mongoose.startSession();

  try {
    const accessToken = await getAccessToken();
    if (!accessToken) {
      return {
        success: false,
        message: "Failed to get Ekart access token",
      };
    }

    session.startTransaction();

    // 1️⃣ Lock order
    const currentOrder = await Order.findOneAndUpdate(
      { _id: id, status: "new" },
      { $set: { status: "processing" } },
      { new: true, session },
    );

    if (!currentOrder) {
      await session.abortTransaction();
      session.endSession();
      return {
        success: false,
        message: "Order not in 'new' status",
      };
    }

    const eddData = await estimatedDeliveryDate.findOne({
      courier: "Ekart",
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

    // 2️⃣ Zone check
    const zone = await getZone(
      currentOrder.pickupAddress.pinCode,
      currentOrder.receiverAddress.pinCode,
    );

    if (!zone) {
      await Order.findByIdAndUpdate(id, { status: "new" });
      await session.abortTransaction();
      session.endSession();
      return { success: false, message: "Pincode not serviceable" };
    }

    // 3️⃣ Wallet check
    const user = await User.findById(currentOrder.userId).session(session);
    const wallet = await Wallet.findById(user.Wallet).session(session);

    const holdAmount = wallet.holdAmount || 0;
    const effectiveBalance = wallet.balance - holdAmount;
    const balance = effectiveBalance + wallet.creditLimit;

    if (balance < finalCharges) {
      await Order.findByIdAndUpdate(id, { status: "new" });
      await session.abortTransaction();
      session.endSession();
      return { success: false, message: "Insufficient Wallet Balance" };
    }

    // 4️⃣ Pickup address
    const pickup = await pickupAddress
      .findOne({
        "pickupAddress.contactName": currentOrder.pickupAddress.contactName,
        "pickupAddress.address": currentOrder.pickupAddress.address,
        "pickupAddress.pinCode": currentOrder.pickupAddress.pinCode,
      })
      .session(session);

    if (!pickup) {
      await Order.findByIdAndUpdate(id, { status: "new" });
      await session.abortTransaction();
      session.endSession();
      return { success: false, message: "Pickup address not found" };
    }

    let ekartAlias = pickup.ekartAlias;

    // 5️⃣ Register pickup if alias missing
    if (!ekartAlias) {
      const addResult = await addEkartAddress(
        {
          alias: `WAREHOUSE_${Date.now()}`,
          phone: pickup.pickupAddress.phoneNumber,
          address_line1: pickup.pickupAddress.address,
          address_line2: "",
          pincode: pickup.pickupAddress.pinCode,
          city: pickup.pickupAddress.city,
          state: pickup.pickupAddress.state,
          country: "IN",
          geo: { lat: 0, lon: 0 },
        },
        accessToken,
      );

      if (!addResult?.success) {
        await Order.findByIdAndUpdate(id, { status: "new" });
        await session.abortTransaction();
        session.endSession();
        return {
          success: false,
          message: "Failed to register pickup address with Ekart",
          error: addResult?.error,
        };
      }

      ekartAlias = addResult.alias;

      await pickupAddress.updateOne(
        { _id: pickup._id },
        { ekartAlias },
        { session },
      );
    }

    // 6️⃣ GST calculation
    const { updatedItems, totalTaxValue } = calculateGSTForItems(
      currentOrder.productDetails,
      pickup.pickupAddress.state.trim(),
      currentOrder.receiverAddress.state.trim(),
      process.env.SELLER_GST_TIN || "",
    );

    const todayStr = new Date().toISOString().split("T")[0];
    const isCOD = currentOrder.paymentDetails.method === "COD";

    const cleanItems = updatedItems.map((i) => (i.toObject ? i.toObject() : i));

    const totalQuantity = cleanItems.reduce(
      (s, p) => s + (p._doc.quantity || 0),
      0,
    );

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

    // 7️⃣ Ekart payload
    const payload = {
      seller_name: pickup.pickupAddress.contactName,
      seller_address: pickup.pickupAddress.address,
      seller_gst_tin: process.env.SELLER_GST_TIN || "",

      order_number: String(currentOrder.orderId),
      invoice_number: String(currentOrder.orderId),
      invoice_date: todayStr,

      consignee_gst_amount: totalTaxValue,
      consignee_name: currentOrder.receiverAddress.contactName,
      products_desc: updatedItems.map((p) => p.name).join(", ") || "Goods",

      payment_mode: isCOD ? "COD" : "Prepaid",
      total_amount: currentOrder.paymentDetails.amount,
      taxable_amount: currentOrder.paymentDetails.amount,
      _taxable_amount: currentOrder.paymentDetails.amount,
      tax_value: totalTaxValue,
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

    // 8️⃣ Ekart API call
    let response;
    try {
      response = await axios.put(
        "https://app.elite.ekartlogistics.in/api/v1/package/create",
        payload,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          timeout: 15000,
        },
      );
    } catch (err) {
      await Order.findByIdAndUpdate(id, { status: "new" });
      await session.abortTransaction();
      session.endSession();
      return {
        success: false,
        message: err.response?.data?.description || "Ekart Shipment Failed",
        error: err.response?.data || err.message,
      };
    }

    if (!response?.data?.status) {
      await Order.findByIdAndUpdate(id, { status: "new" });
      await session.abortTransaction();
      session.endSession();
      return {
        success: false,
        message: response.data?.message || "Ekart error",
      };
    }

    // 9️⃣ Order update
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
          estimatedDeliveryDate: estimateDate || "",
          priceBreakup
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

    // 🔟 Wallet update (post-commit)
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
              balanceAfterTransaction: wallet.balance - balanceToBeDeducted,
              date: new Date(),
              awb_number: response.data.tracking_id,
              description: "Freight Charges Applied",
            },
          },
        },
      );
    } catch (e) {
      console.error("Wallet update failed:", e.message);
    }

    return {
      success: true,
      message: "Shipment Created Successfully",
      awb_number: response.data.tracking_id,
    };
  } catch (error) {
    await Order.findByIdAndUpdate(id, { status: "new" });
    await session.abortTransaction();
    session.endSession();
    return {
      success: false,
      message: "Failed to create shipment",
      error: error.message,
    };
  }
};

module.exports = createEkartShipment;
