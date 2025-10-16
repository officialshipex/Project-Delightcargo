const axios = require("axios");
require("dotenv").config();
const Order = require("../../../models/newOrder.model");
const { getZone } = require("../../../Rate/zoneManagementController");
const Wallet = require("../../../models/wallet");
const User = require("../../../models/User.model");
const PickupAddress = require("../../../models/pickupAddress.model");
const token = process.env.VAMASHIP_API_KEY;

function ensureValidAddress(addr) {
  if (!addr) return "No Address Provided";
  if (addr.length < 10) {
    return addr + " ".repeat(10 - addr.length) + " (Full address required)";
  }
  return addr;
}
const createVamashipShipment = async (req, res) => {
  try {
    const { id, finalCharges, courierServiceName, provider } = req.body;

    // Fetch order
    const currentOrder = await Order.findById(id);
    if (!currentOrder) {
      return res
        .status(404)
        .json({ success: false, message: "Order not found" });
    }

    if (currentOrder.status !== "new") {
      return res.status(400).json({
        success: false,
        message: `Shipment cannot be created because order status is '${currentOrder.status}'.`,
      });
    }

    // Fetch user
    const user = await User.findById(currentOrder.userId);
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    // Fetch wallet
    const currentWallet = await Wallet.findById(user.Wallet);
    if (!currentWallet) {
      return res
        .status(404)
        .json({ success: false, message: "Wallet not found" });
    }

    const zone = await getZone(
      currentOrder.pickupAddress.pinCode,
      currentOrder.receiverAddress.pinCode
    );

    const effectiveBalance =
      currentWallet.balance - (currentWallet.holdAmount || 0);
    if (effectiveBalance < finalCharges) {
      return res
        .status(400)
        .json({ success: false, message: "Insufficient wallet balance" });
    }

    // Prepare payload according to Vamaship API
    const payload = {
      seller: {
        address: ensureValidAddress(currentOrder.pickupAddress.address),
        city: currentOrder.pickupAddress.city,
        country: currentOrder.pickupAddress.country || "India",
        email: currentOrder.pickupAddress.email,
        name: currentOrder.pickupAddress.contactName,
        phone: currentOrder.pickupAddress.phoneNumber,
        pincode: currentOrder.pickupAddress.pinCode,
        state: currentOrder.pickupAddress.state,
        get_all_quotes: false,
      },
      shipments: [
        {
          address: ensureValidAddress(currentOrder.receiverAddress.address),
          breadth:
            currentOrder.packageDetails.volumetricWeight.width.toString(),
          city: currentOrder.receiverAddress.city,
          country: currentOrder.receiverAddress.country || "India",
          email: currentOrder.receiverAddress.email || "noemail@example.com",
          height:
            currentOrder.packageDetails.volumetricWeight.height.toString(),
          is_cod: currentOrder.paymentDetails.method === "COD",
          length:
            currentOrder.packageDetails.volumetricWeight.length.toString(),
          name: currentOrder.receiverAddress.contactName,
          phone: currentOrder.receiverAddress.phoneNumber,
          pickup_date: new Date().toISOString(),
          pincode: currentOrder.receiverAddress.pinCode,
          product: currentOrder.productDetails.map((p) => p.name).join(", "),
          product_value: currentOrder.paymentDetails.amount,
          line_items: currentOrder.productDetails.map((product) => ({
            product_name: product.name,
            quantity: product.quantity,
            weight: product.unitWeight || 0.5,
            weight_unit: "kg",
            price: product.unitPrice,
          })),
          cod_value:
            currentOrder.paymentDetails.method === "COD"
              ? currentOrder.paymentDetails.amount
              : 0,
          quantity: currentOrder.productDetails.reduce(
            (sum, p) => sum + p.quantity,
            0
          ),
          reference1: currentOrder.orderId,
          surface_category: "b2c",
          reference2: `REF-${Date.now()}`,
          state: currentOrder.receiverAddress.state,
          unit: "cm",
          weight: currentOrder.packageDetails.applicableWeight.toString(),
          return_address: {
            email: currentOrder.pickupAddress.email,
            name: currentOrder.pickupAddress.contactName,
            phone: currentOrder.pickupAddress.phoneNumber,
            address: ensureValidAddress(currentOrder.pickupAddress.address),
            pincode: currentOrder.pickupAddress.pinCode,
            city: currentOrder.pickupAddress.city,
            state: currentOrder.pickupAddress.state,
            country: currentOrder.pickupAddress.country || "India",
          },
        },
      ],
    };

    // API call
    const response = await axios.post(
      "https://ecom.vamaship.com/ecom/api/v1/surface/book", // Replace with correct endpoint
      payload,
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`, // Store token in env
        },
      }
    );

    const respData = response.data;
    // console.log("vamaship response", respData);
    // console.log("vamaship", respData.quotes[0].messages);
    const firstQuote = respData.quotes?.[0];

    // Check both main success and quote success
    if (!respData.success || !firstQuote?.success) {
      return res.status(400).json({
        success: false,
        message: "Failed to create shipment",
        details: firstQuote?.messages || respData,
      });
    }
    // Extract shipment details
    const shipmentInfo = respData.shipments?.[0];
    if (shipmentInfo?.awb) {
      currentOrder.status = "Ready To Ship";
      currentOrder.awb_number = shipmentInfo.awb;
      currentOrder.shipment_id = shipmentInfo.order_id;
      currentOrder.provider = provider;
      currentOrder.totalFreightCharges = parseInt(finalCharges);
      currentOrder.courierServiceName = courierServiceName;
      currentOrder.shipmentCreatedAt = new Date();
      currentOrder.zone=zone.zone;
      await currentOrder.save();

      await currentWallet.updateOne({
        $inc: { balance: -parseInt(finalCharges) },
        $push: {
          transactions: {
            channelOrderId: currentOrder.orderId,
            category: "debit",
            amount: parseInt(finalCharges),
            balanceAfterTransaction: effectiveBalance - parseInt(finalCharges),
            date: new Date(),
            awb_number: shipmentInfo.awb,
            description: `Freight Charges Applied`,
          },
        },
      });
    }

    return res.status(200).json({
      message: "Shipment Created Successfully",
      success: true,
      data: respData,
    });
  } catch (error) {
    console.error(
      "Vamaship Shipment Creation Error:",
      error?.response?.data || error.message
    );
    return res.status(500).json({
      success: false,
      message: "Failed to create shipment",
      error: error?.response?.data || error.message,
    });
  }
};

const checkVamashipServiceability = async (payload) => {
  try {
    const requestBody = {
      origin: payload.source_pincode,
      type: payload.payment_type.toLowerCase(),
      subtype: "surface_b2c",
    };

    const response = await axios.post(
      "https://ecom.vamaship.com/ecom/api/v1/surface/coverage",
      requestBody,
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      }
    );
    // console.log("vamaship",response.data)
    if (response.data.success === true) {
      const destinations = response.data.destinations;
      // console.log("des",destinations)
      // console.log(payload)
      // ✅ Check if destination pincode exists
      const isServiceable = destinations.includes(
        Number(payload.destination_pincode)
      );

      // console.log(isServiceable)

      return {
        success: isServiceable,
      };
    }

    return { success: false };
  } catch (err) {
    console.error(
      "Smartship Serviceability Error:",
      err.response?.data || err.message
    );
    return {
      success: false,
      error: err.response?.data || err.message,
    };
  }
};

const cancelVamashipOrder = async (shipment_id) => {
  try {
    if (!shipment_id) {
      return {
        success: false,
        message: "shipment_id is required",
      };
    }

    // Check if already cancelled
    const isCancelled = await Order.findOne({
      shipment_id: shipment_id,
      status: "Cancelled",
    });

    if (isCancelled) {
      return {
        code: 400,
        error: "Order is already cancelled",
      };
    }

    // Prepare request body (API expects an array)
    const requestPayload = {
      order_ids: [shipment_id],
    };

    // Call Vamaship API
    const response = await axios.post(
      "https://ecom.vamaship.com/ecom/api/v1/cancel",
      requestPayload,
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      }
    );

    const result = response?.data || {};
    const cancellationResult = result[shipment_id];

    if (cancellationResult?.success) {
      // Update in DB
      await Order.updateOne(
        { shipment_id: shipment_id },
        { $set: { status: "Cancelled" } }
      );

      return {
        code: 201,
        success: true,
        message: cancellationResult.status || "Order cancelled successfully",
      };
    } else {
      return {
        code: 400,
        error: true,
        message: cancellationResult?.status || "Failed to cancel order",
      };
    }
  } catch (error) {
    console.error(
      "Vamaship Cancel Order Error:",
      error?.response?.data || error.message
    );
    return {
      error: true,
      message: "Failed to cancel order",
      data: error?.response?.data || error.message,
    };
  }
};

const trackOrderVamaship = async (AWBNo) => {
  try {
    // Call Vamaship tracking endpoint
    const response = await axios.get(
      `https://ecom.vamaship.com/ecom/api/v1/trackawb/${AWBNo}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );

    const trackingData = response.data?.tracking_details?.[AWBNo];

    if (!trackingData) {
      return {
        success: false,
        message: "No tracking details found for given AWB",
        status: 404,
      };
    }

    if (!trackingData.success) {
      return {
        success: false,
        message: "Tracking request failed",
        details: trackingData,
        status: 400,
      };
    }

    // Return clean tracking info
    return {
      success: true,
      awb: AWBNo,
      events: trackingData.trackingEvents || [],
    };
  } catch (error) {
    console.error(
      "Error tracking Vamaship shipment:",
      error.response?.data || error.message
    );
    return {
      success: false,
      error: error.response?.data || error.message,
      status: 500,
    };
  }
};

module.exports = {
  checkVamashipServiceability,
  cancelVamashipOrder,
  createVamashipShipment,
  trackOrderVamaship,
};
