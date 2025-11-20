const axios = require("axios");
const User = require("../../../models/User.model");
const Order = require("../../../models/newOrder.model");
const Wallet = require("../../../models/wallet");
const { getZone } = require("../../../Rate/zoneManagementController");
const CourierService = require("../../../models/CourierService.Schema");
require("dotenv").config();

// Ekart API URL
const EKART_API_URL = "https://app.elite.ekartlogistics.in/api/v1/package/create";

const createBulkEkartShipment = async (
  serviceDetails,
  orderId,
  walletId,
  charges
) => {
  try {
    // 1. Order Fetch
    const currentOrder = await Order.findById(orderId);
    if (!currentOrder) {
      return { success: false, message: "Order not found" };
    }

    // 2. Check service
    const service = await CourierService.findOne({ name: serviceDetails.name });
    if (!service) {
      return { success: false, message: "Courier service not found" };
    }

    // 3. Check zone
    const zone = await getZone(
      currentOrder.pickupAddress.pinCode,
      currentOrder.receiverAddress.pinCode
    );
    if (!zone) {
      return { success: false, message: "Pincode not serviceable" };
    }

    // 4. Wallet & Balance check
    const currentWallet = await Wallet.findById(walletId);
    if (!currentWallet) {
      return { success: false, message: "Wallet not found" };
    }

    const walletHold = currentWallet?.holdAmount || 0;
    const effectiveBalance = currentWallet.balance - walletHold;
    const balance = currentWallet.balance + currentWallet.creditLimit;

    if (balance < charges) {
      return { success: false, message: "Insufficient wallet balance" };
    }

    // 5. Ekart Access Token
    const accessToken = await getAccessToken();
    if (!accessToken) {
      return { success: false, message: "Failed to get access token" };
    }

    // 6. Prepare payload
    const todayStr = new Date().toISOString().split("T")[0];
    const isCOD = currentOrder.paymentDetails.method === "COD";

    const productsDesc =
      currentOrder.productDetails.map((p) => p.name).join(", ") || "Goods";

    const totalQuantity = currentOrder.productDetails.reduce(
      (sum, p) => sum + (p.quantity || 1),
      0
    );

    const firstProduct = currentOrder.productDetails[0] || {};

    const items = currentOrder.productDetails.map((p) => ({
      product_name: p.name || "",
      sku: p.sku || "",
      taxable_value: Number(p.unitPrice || 0) * (p.quantity || 1),
      description: p.name || "",
      quantity: p.quantity || 1,
      length:
        p.length || currentOrder.packageDetails.volumetricWeight.length || 0,
      height:
        p.height || currentOrder.packageDetails.volumetricWeight.height || 0,
      breadth:
        p.width || currentOrder.packageDetails.volumetricWeight.width || 0,
      weight: p.weight || currentOrder.packageDetails.applicableWeight || 1,
      hsn_code: p.hsnCode || "",
      cgst_tax_value: 0,
      sgst_tax_value: 0,
      igst_tax_value: 0,
    }));

    const payload = {
      seller_name: currentOrder.pickupAddress.contactName,
      seller_address: currentOrder.pickupAddress.address,
      seller_gst_tin: "",

      seller_gst_amount: 0,
      consignee_gst_amount: 0,
      integrated_gst_amount: 0,

      ewbn: "",
      order_number: currentOrder.orderId,
      invoice_number: currentOrder.orderId,
      invoice_date: todayStr,
      document_number: "",
      document_date: todayStr,

      consignee_gst_tin: "",
      consignee_name: currentOrder.receiverAddress.contactName || "",
      products_desc: productsDesc,

      payment_mode: isCOD ? "COD" : "Prepaid",

      category_of_goods: productsDesc,
      hsn_code: "",
      total_amount: currentOrder.paymentDetails.amount,
      tax_value: 0,
      taxable_amount: currentOrder.paymentDetails.amount,
      commodity_value: "",
      cod_amount: isCOD ? currentOrder.paymentDetails.amount : 0,

      quantity: totalQuantity,
      templateName: "default",

      weight: currentOrder.packageDetails.applicableWeight,
      length: currentOrder.packageDetails.volumetricWeight.length,
      height: currentOrder.packageDetails.volumetricWeight.height,
      width: currentOrder.packageDetails.volumetricWeight.width,

      return_reason: "",

      drop_location: {
        location_type: "Office",
        address: currentOrder.receiverAddress.address,
        city: currentOrder.receiverAddress.city,
        state: currentOrder.receiverAddress.state,
        country: "IN",
        name: currentOrder.receiverAddress.contactName,
        phone: currentOrder.receiverAddress.phoneNumber,
        pin: +currentOrder.receiverAddress.pinCode,
      },

      pickup_location: {
        location_type: "Office",
        address: currentOrder.pickupAddress.address,
        city: currentOrder.pickupAddress.city,
        state: currentOrder.pickupAddress.state,
        country: "IN",
        name: currentOrder.pickupAddress.contactName,
        phone: currentOrder.pickupAddress.phoneNumber,
        pin: +currentOrder.pickupAddress.pinCode,
      },

      return_location: {
        location_type: "Office",
        address: currentOrder.pickupAddress.address,
        city: currentOrder.pickupAddress.city,
        state: currentOrder.pickupAddress.state,
        country: "IN",
        name: currentOrder.pickupAddress.contactName,
        phone: currentOrder.pickupAddress.phoneNumber,
        pin: +currentOrder.pickupAddress.pinCode,
      },

      qc_details: {
        qc_shipment: true,
        product_name: firstProduct.name || "",
        product_desc: firstProduct.name || "",
        product_sku: firstProduct.sku || "",
        product_color: firstProduct.color || "",
        product_size: firstProduct.size || "",
        brand_name: firstProduct.brand || "",
        product_category: firstProduct.category || "",
        ean_barcode: firstProduct.eanBarcode || "",
        serial_number: firstProduct.serialNumber || "",
        imei_number: firstProduct.imeiNumber || "",
        product_images: firstProduct.images || [],
      },

      items,
      what3words_address: "",
    };

    // 7. Ekart API call
    let response;
    try {
      response = await axios.post(EKART_API_URL, payload, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      });
    } catch (err) {
      return {
        success: false,
        message: err.response?.data?.message || "Ekart shipment failed",
        error: err.response?.data || err.message,
      };
    }

    if (!response?.data?.status) {
      return {
        success: false,
        message: response.data?.message || "Ekart failed",
      };
    }

    // 8. Update order
    const trackingId = response.data.tracking_id;

    currentOrder.status = "Booked";
    currentOrder.cancelledAtStage = null;
    currentOrder.awb_number = trackingId;
    currentOrder.shipment_id = currentOrder.orderId;
    currentOrder.provider = serviceDetails.provider;
    currentOrder.courierServiceName = serviceDetails.name;
    currentOrder.totalFreightCharges = charges;
    currentOrder.shipmentCreatedAt = new Date();
    currentOrder.zone = zone.zone;

    currentOrder.tracking.push({
      status: "Booked",
      StatusLocation: currentOrder.pickupAddress.city,
      StatusDateTime: new Date(),
      Instructions: "Order booked successfully",
    });

    await currentOrder.save();

    // 9. Wallet update (atomic)
    await Wallet.findOneAndUpdate(
      { _id: walletId, balance: { $gte: charges } },
      {
        $inc: { balance: -charges },
        $push: {
          transactions: {
            channelOrderId: currentOrder.orderId,
            category: "debit",
            amount: charges,
            balanceAfterTransaction: currentWallet.balance - charges,
            date: new Date(),
            description: "Freight Charges Applied",
            awb_number: trackingId,
          },
        },
      }
    );

    return {
      success: true,
      message: "Ekart Shipment Created Successfully",
      waybill: trackingId,
      orderId: currentOrder.orderId,
    };
  } catch (err) {
    return {
      success: false,
      message: "Failed to create Ekart shipment",
      error: err.response?.data || err.message,
    };
  }
};

module.exports = { createBulkEkartShipment };
