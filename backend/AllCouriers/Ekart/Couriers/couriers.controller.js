const axios = require("axios");
const { getAccessToken } = require("../Authorize/Ekart.controller"); // import your token function
const Order = require("../../../models/newOrder.model");
const { getZone } = require("../../../Rate/zoneManagementController");
const User = require("../../../models/User.model");
const Wallet = require("../../../models/wallet");

const orderCreationEkart = async (req, res) => {
  try {
    const { id, finalCharges, courierServiceName, provider } = req.body;

    // 1. Get access token
    const accessToken = await getAccessToken();
    if (!accessToken) {
      return res
        .status(500)
        .json({ success: false, message: "Failed to get access token" });
    }

    // 2. Fetch order
    const currentOrder = await Order.findById(id);
    if (!currentOrder) {
      return res
        .status(404)
        .json({ success: false, message: "Order not found" });
    }

    // 3. Check zone serviceability (if getZone is implemented)
    const zone = await getZone(
      currentOrder.pickupAddress.pinCode,
      currentOrder.receiverAddress.pinCode
    );
    if (!zone) {
      return res
        .status(400)
        .json({ success: false, message: "Pincode not serviceable" });
    }

    // 4. Fetch user & wallet
    const user = await User.findById(currentOrder.userId);
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    const wallet = await Wallet.findById(user.Wallet);
    if (!wallet) {
      return res
        .status(404)
        .json({ success: false, message: "Wallet not found" });
    }

    // 5. Check wallet balance
    const effectiveBalance = wallet.balance - (wallet.holdAmount || 0);
    const balance = wallet.balance + (wallet.creditLimit || 0);
    if (balance < finalCharges) {
      return res
        .status(400)
        .json({ success: false, message: "Insufficient wallet balance" });
    }

    // 6. Prepare data for API payload
    const todayStr = new Date().toISOString().split("T")[0]; // yyyy-mm-dd
    const isCOD = currentOrder.paymentDetails.method === "COD";

    // products_desc: comma separated product names
    const productsDesc =
      currentOrder.productDetails
        .map((p) => p.name)
        .filter(Boolean)
        .join(", ") || "Goods";

    // Total quantity sum across products
    const totalQuantity = currentOrder.productDetails.reduce(
      (sum, p) => sum + (p.quantity || 0),
      0
    );

    // Construct items array for shipment
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

    // For qc_details, take first product or empty
    const firstProduct = currentOrder.productDetails[0] || {};

    // Define seller info here or fetch from your env/config
    const sellerName =
      process.env.SELLER_NAME ||
      currentOrder.pickupAddress.contactName ||
      "Seller Name";
    const sellerAddress =
      process.env.SELLER_ADDRESS ||
      currentOrder.pickupAddress.address ||
      "Seller Address";
    const sellerGstTin = process.env.SELLER_GST_TIN || "";

    // Payload for Ekart shipment create API
    const payload = {
      seller_name: sellerName,
      seller_address: sellerAddress,
      seller_gst_tin: sellerGstTin,
      seller_gst_amount: 0,
      consignee_gst_amount: 0,
      integrated_gst_amount: 0,
      ewbn: "", // fill if available
      order_number: currentOrder.orderId?.toString() || "",
      invoice_number: currentOrder.orderId?.toString() || "",
      invoice_date: todayStr,
      document_number: "",
      document_date: todayStr,
      consignee_gst_tin: "",
      consignee_name: currentOrder.receiverAddress.contactName || "",
      products_desc: productsDesc,
      payment_mode: isCOD ? "COD" : "Prepaid",
      category_of_goods: productsDesc, // or categorize logically
      hsn_code: "", // add if you have
      total_amount: currentOrder.paymentDetails.amount || 0,
      tax_value: 0,
      taxable_amount: currentOrder.paymentDetails.amount || 0,
      commodity_value: "",
      cod_amount: isCOD ? currentOrder.paymentDetails.amount : 0,
      quantity: totalQuantity,
      templateName: "default",
      weight: currentOrder.packageDetails.applicableWeight || 1,
      length: currentOrder.packageDetails.volumetricWeight.length || 0,
      height: currentOrder.packageDetails.volumetricWeight.height || 0,
      width: currentOrder.packageDetails.volumetricWeight.width || 0,
      return_reason: "",
      drop_location: {
        location_type: "Office",
        address: currentOrder.receiverAddress.address || "",
        city: currentOrder.receiverAddress.city || "",
        state: currentOrder.receiverAddress.state || "",
        country: "IN",
        name: currentOrder.receiverAddress.contactName || "",
        phone: currentOrder.receiverAddress.phoneNumber || "",
        pin: +currentOrder.receiverAddress.pinCode || 0,
      },
      pickup_location: {
        location_type: "Office",
        address: currentOrder.pickupAddress.address || "",
        city: currentOrder.pickupAddress.city || "",
        state: currentOrder.pickupAddress.state || "",
        country: "IN",
        name: currentOrder.pickupAddress.contactName || "",
        phone: currentOrder.pickupAddress.phoneNumber || "",
        pin: +currentOrder.pickupAddress.pinCode || 0,
      },
      return_location: {
        location_type: "Office",
        address: currentOrder.pickupAddress.address || "",
        city: currentOrder.pickupAddress.city || "",
        state: currentOrder.pickupAddress.state || "",
        country: "IN",
        name: currentOrder.pickupAddress.contactName || "",
        phone: currentOrder.pickupAddress.phoneNumber || "",
        pin: +currentOrder.pickupAddress.pinCode || 0,
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
      what3words_address: "", // provide if available
    };

    // 7. Call Ekart API
    const ekartApiUrl =
      "https://app.elite.ekartlogistics.in/api/v1/package/create";

    const response = await axios.post(ekartApiUrl, payload, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    });

    // 8. Update order and wallet on success
    if (
      (response.status === 200 || response.status === 201) &&
      response.data.status === true
    ) {
      currentOrder.status = "Ready To Ship";
      currentOrder.provider = provider;
      currentOrder.courierServiceName = courierServiceName;
      currentOrder.totalFreightCharges = finalCharges;
      currentOrder.shipmentCreatedAt = new Date();
      currentOrder.awb_number = response.data.tracking_id;
      currentOrder.shipment_id = currentOrder.orderId;
      currentOrder.totalFreightCharges =
        finalCharges === "N/A" ? 0 : parseInt(finalCharges);
      currentOrder.zone = zone.zone;
      await currentOrder.save();

      // Deduct wallet balance and add transaction record
      await wallet.updateOne({
        $inc: { balance: -finalCharges },
        $push: {
          transactions: {
            channelOrderId: currentOrder.orderId,
            category: "debit",
            amount: finalCharges,
            balanceAfterTransaction: wallet.balance - finalCharges,
            date: new Date().toISOString.slice(0, 16).replace("T", " "),
            description: `Freight Charges Applied`,
            awb_number: response.data.tracking_id,
          },
        },
      });

      return res.status(200).json({
        success: true,
        message: "Shipment Created Successfully",
        data: response.data,
      });
    }

    // 9. Handle non-successful Ekart response
    return res.status(400).json({
      success: false,
      message: "Failed to create shipment on Ekart",
      data: response.data,
    });
  } catch (error) {
    console.error(
      "Ekart order creation error:",
      error.response?.data || error.message || error
    );
    return res.status(500).json({
      success: false,
      message: "Failed to create shipment",
      error: error.response?.data || error.message,
    });
  }
};

const cancelShipmentEkart = async (tracking_id) => {
  try {
    if (!tracking_id) {
      return {
        success: false,
        message: "tracking_id query parameter is required",
      };
    }

    const isCancelled = await Order.findOne({
      awb_number: tracking_id,
      status: "Cancelled",
    });
    if (isCancelled) {
      console.log("Order is already cancelled");
      return {
        error: "Order is allreday cancelled",
        code: 400,
      };
    }

    // Fetch valid access token
    const accessToken = await getAccessToken();
    if (!accessToken) {
      return { success: false, message: "Failed to get access token" };
    }

    // Call Ekart cancel shipment API
    const ekartCancelUrl = `https://app.elite.ekartlogistics.in/api/v1/package/cancel?tracking_id=${encodeURIComponent(
      tracking_id
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
      await Order.updateOne(
        { awb_number: tracking_id },
        { $set: { status: "Cancelled" } }
      );

      return {
        data:response.data,
        code:201
      };
    } else {
      // If API response says cancellation failed
      return {
        error:"Error in shipment cancellation",
        details:response.data,
        code:400
      };
    }
  } catch (error) {
    console.error(
      "Error cancelling shipment with Ekart:",
      error.response?.data || error.message || error
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
        { headers }
      ),
      axios.get(
        `https://app.elite.ekartlogistics.in/api/v2/serviceability/${receiverPincode}`,
        { headers }
      ),
    ]);

    const pickupData = pickupResponse.data;
    const receiverData = receiverResponse.data;

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
      error.response?.data || error.message
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
};
