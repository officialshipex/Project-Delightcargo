const axios = require("axios");
const { getAccessToken } = require("../Authorize/Ekart.controller"); // import your token function
const Order = require("../../../models/newOrder.model");
const { getZone } = require("../../../Rate/zoneManagementController");
const User = require("../../../models/User.model");
const Wallet = require("../../../models/wallet");

const orderCreationEkart = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    const { id, finalCharges, courierServiceName, provider } = req.body;

    // --- Fetch Access Token ---
    const accessToken = await getAccessToken();
    if (!accessToken) {
      return res.status(500).json({
        success: false,
        message: "Failed to get access token",
      });
    }

    session.startTransaction();

    // --- Fetch & lock order atomically ---
    const currentOrder = await Order.findOneAndUpdate(
      { _id: id, status: "new" },
      { $set: { status: "processing" } },
      { new: true, session }
    );

    if (!currentOrder) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message:
          "Shipment cannot be created because order is already processed or not in 'new' status.",
      });
    }

    // --- Check zone ---
    const zone = await getZone(
      currentOrder.pickupAddress.pinCode,
      currentOrder.receiverAddress.pinCode
    );

    if (!zone) {
      await Order.findByIdAndUpdate(id, { status: "new" });
      await session.abortTransaction();
      session.endSession();
      return res
        .status(400)
        .json({ success: false, message: "Pincode not serviceable" });
    }

    // --- Fetch user & wallet inside transaction ---
    const user = await User.findById(currentOrder.userId).session(session);

    if (!user) {
      await Order.findByIdAndUpdate(id, { status: "new" });
      await session.abortTransaction();
      session.endSession();
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    const currentWallet = await Wallet.findById(user.Wallet).session(session);

    if (!currentWallet) {
      await Order.findByIdAndUpdate(id, { status: "new" });
      await session.abortTransaction();
      session.endSession();
      return res
        .status(404)
        .json({ success: false, message: "Wallet not found" });
    }

    // --- Wallet balance check ---
    const effectiveBalance =
      currentWallet.balance - (currentWallet.holdAmount || 0);
    const balance = currentWallet.balance + currentWallet.creditLimit;

    if (balance < finalCharges) {
      await Order.findByIdAndUpdate(id, { status: "new" });
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: "Insufficient Wallet Balance",
      });
    }

    // --- Build Ekart Payload ---
    const todayStr = new Date().toISOString().split("T")[0];
    const isCOD = currentOrder.paymentDetails.method === "COD";

    const productsDesc =
      currentOrder.productDetails.map((p) => p.name).join(", ") || "Goods";

    const totalQuantity = currentOrder.productDetails.reduce(
      (sum, p) => sum + (p.quantity || 0),
      0
    );

    const firstProduct = currentOrder.productDetails[0] || {};

    const items = currentOrder.productDetails.map((p) => ({
      product_name: p.name || "",
      sku: p.sku || "",
      taxable_value: (p.unitPrice || 0) * (p.quantity || 1),
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
      seller_name:
        process.env.SELLER_NAME ||
        currentOrder.pickupAddress.contactName ||
        "Seller",
      seller_address:
        process.env.SELLER_ADDRESS ||
        currentOrder.pickupAddress.address ||
        "Seller Address",
      seller_gst_tin: process.env.SELLER_GST_TIN || "",
      seller_gst_amount: 0,
      consignee_gst_amount: 0,
      integrated_gst_amount: 0,
      ewbn: "",
      order_number: currentOrder.orderId || "",
      invoice_number: currentOrder.orderId || "",
      invoice_date: todayStr,
      document_number: "",
      document_date: todayStr,
      consignee_gst_tin: "",
      consignee_name: currentOrder.receiverAddress.contactName || "",
      products_desc: productsDesc,
      payment_mode: isCOD ? "COD" : "Prepaid",
      category_of_goods: productsDesc,
      hsn_code: "",
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

    // --- Ekart API call ---
    let response;
    try {
      response = await axios.post(
        "https://app.elite.ekartlogistics.in/api/v1/package/create",
        payload,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
        }
      );
    } catch (err) {
      await Order.findByIdAndUpdate(id, { status: "new" });
      await session.abortTransaction();
      session.endSession();
      return res.status(500).json({
        success: false,
        message: err.response?.data?.message || "Ekart Shipment Failed",
        error: err.response?.data || err.message,
      });
    }

    if (!response?.data?.status) {
      await Order.findByIdAndUpdate(id, { status: "new" });
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: response.data?.message || "Shipment Failed",
      });
    }

    // --- Update Order inside session ---
    const balanceToBeDeducted = parseFloat(finalCharges) || 0;

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
          cancelledAtStage: null,
          shipmentCreatedAt: new Date(),
          zone: zone.zone,
        },
        $push: {
          tracking: {
            status: "Booked",
            StatusLocation: currentOrder.pickupAddress.city || "",
            StatusDateTime: new Date(),
            Instructions: "Order booked successfully",
          },
        },
      },
      { session, new: true }
    );

    await session.commitTransaction();
    session.endSession();

    // --- Send Early Response ---
    res.status(200).json({
      success: true,
      message: "Shipment Created Successfully",
      awb: response.data.tracking_id,
    });

    // --- Wallet update in background ---
    process.nextTick(async () => {
      try {
        await Wallet.findOneAndUpdate(
          { _id: user.Wallet, balance: { $gte: balanceToBeDeducted } },
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
          }
        );
      } catch (err) {
        console.error("Wallet update error:", err.message);
      }
    });
  } catch (err) {
    await Order.findByIdAndUpdate(req.body.id, { status: "new" });
    await session.abortTransaction();
    session.endSession();
    return res.status(500).json({
      success: false,
      message: "Failed to create shipment",
      error: err.response?.data || err.message,
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
