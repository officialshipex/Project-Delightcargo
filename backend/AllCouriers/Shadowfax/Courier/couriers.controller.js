if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

const axios = require("axios");
const mongoose = require("mongoose");
const Order = require("../../../models/newOrder.model");
const Wallet = require("../../../models/wallet");
const User = require("../../../models/User.model");
const { getShadowfaxToken } = require("../Authorize/saveCourierController");

const SHADOWFAX_BASE_URL =
  process.env.SHADOWFAX_URL || "https://dale.shadowfax.in/api";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const getAuthHeaders = async (courierName) => {
  const token = await getShadowfaxToken(courierName);
  return {
    Authorization: `Token ${token}`,
    "Content-Type": "application/json",
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// CHECK PINCODE SERVICEABILITY
// GET /v1/clients/serviceability/?service=customer_delivery&pincodes=<pin>
// ─────────────────────────────────────────────────────────────────────────────
const checkPincodeServiceability = async (pincode, courierName) => {
  try {
    const headers = await getAuthHeaders(courierName);
    const response = await axios.get(
      `${SHADOWFAX_BASE_URL}/v1/clients/serviceability/`,
      {
        headers,
        params: {
          service: "customer_delivery",
          page: 1,
          count: 1,
          pincodes: pincode,
        },
        timeout: 10000,
      }
    );
    const data = response.data;
    if (Array.isArray(data) && data.length > 0) {
      return { success: true, serviceable: true, data };
    }
    return { success: true, serviceable: false, data: [] };
  } catch (error) {
    console.error("Shadowfax serviceability error:", error.message);
    return { success: false, serviceable: false, error: error.message };
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// CREATE ORDER (Warehouse model – most common for B2C sellers)
// POST /v3/clients/orders/
// ─────────────────────────────────────────────────────────────────────────────
const createOrder = async (req, res) => {
  const MAX_RETRIES = 1;
  let attempt = 0;

  while (attempt < MAX_RETRIES) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      attempt++;
      const { orderId } = req.body;

      // ── Fetch order ──────────────────────────────────────────────────────
      const currentOrder = await Order.findOne({ orderId }).session(session);
      if (!currentOrder) {
        await session.abortTransaction();
        session.endSession();
        return res
          .status(404)
          .json({ success: false, message: "Order not found." });
      }

      if (currentOrder.status !== "new") {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({
          success: false,
          message: `Order is already processed (status: ${currentOrder.status}).`,
        });
      }

      // ── Wallet check ──────────────────────────────────────────────────────
      const userDoc = await User.findById(currentOrder.userId).session(session);
      if (!userDoc)
        throw new Error("User linked with order not found.");

      const currentWallet = await Wallet.findById(userDoc.Wallet).session(
        session
      );
      if (!currentWallet)
        throw new Error("Wallet linked with user not found.");

      const freightCharges =
        currentOrder.totalFreightCharges === "N/A"
          ? 0
          : parseFloat(currentOrder.totalFreightCharges);

      const totalBalance = (currentWallet.balance || 0) + (currentWallet.creditLimit || 0);
      const effectiveBalance = totalBalance - (currentWallet.holdAmount || 0);

      if (effectiveBalance < freightCharges) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({
          success: false,
          message: "Insufficient wallet balance (including credit limit).",
        });
      }

      // ── Build Shadowfax payload ───────────────────────────────────────────
      const sender = currentOrder.senderAddress || {};
      const receiver = currentOrder.receiverAddress || {};
      const product = currentOrder.productDetails || {};

      // Determine payment mode
      const paymentMode =
        currentOrder.paymentMode === "COD" ? "COD" : "Prepaid";
      const codAmount =
        paymentMode === "COD"
          ? parseFloat(currentOrder.collectableAmount || 0)
          : 0;

      // Weight in grams (Shadowfax expects grams)
      const weightGrams = Math.round(
        parseFloat(currentOrder.physicalWeight || product.weight || 0) * 1000
      );

      const sfxPayload = {
        order_type: "warehouse",
        order_details: {
          client_order_id: currentOrder.orderId,
          actual_weight: weightGrams,
          volumetric_weight: weightGrams,
          product_value: parseFloat(product.value || product.price || 0),
          payment_mode: paymentMode,
          cod_amount: codAmount,
          order_service: "regular",
          total_amount: parseFloat(
            currentOrder.collectableAmount || product.value || 0
          ),
        },
        customer_details: {
          name: receiver.name || receiver.fullName || "Customer",
          contact: String(
            receiver.phoneNumber || receiver.phone || receiver.mobile || ""
          ).replace(/\D/g, "").slice(-10),
          address_line_1:
            receiver.addressLine1 ||
            receiver.address ||
            receiver.houseNumber ||
            "",
          address_line_2: receiver.addressLine2 || receiver.locality || "",
          city: receiver.city || "",
          state: receiver.state || "",
          pincode: parseInt(receiver.pincode || receiver.pin || 0),
        },
        pickup_details: {
          name: sender.name || sender.fullName || sender.warehouseName || "",
          contact: String(
            sender.phoneNumber || sender.phone || sender.mobile || ""
          ).replace(/\D/g, "").slice(-10),
          address_line_1:
            sender.addressLine1 || sender.address || sender.houseNumber || "",
          address_line_2: sender.addressLine2 || sender.locality || "",
          city: sender.city || "",
          state: sender.state || "",
          pincode: parseInt(sender.pincode || sender.pin || 0),
        },
        rto_details: {
          name: sender.name || sender.fullName || sender.warehouseName || "",
          contact: String(
            sender.phoneNumber || sender.phone || sender.mobile || ""
          ).replace(/\D/g, "").slice(-10),
          address_line_1:
            sender.addressLine1 || sender.address || sender.houseNumber || "",
          address_line_2: sender.addressLine2 || sender.locality || "",
          city: sender.city || "",
          state: sender.state || "",
          pincode: parseInt(sender.pincode || sender.pin || 0),
        },
        product_details: [
          {
            sku_name:
              product.productName || product.name || "Product",
            price: parseFloat(product.value || product.price || 0),
            category: product.category || "General",
            invoice_no: currentOrder.orderId,
            additional_details: {
              quantity: parseInt(product.quantity || 1),
            },
          },
        ],
      };

      // ── Call Shadowfax API ────────────────────────────────────────────────
      const headers = await getAuthHeaders(currentOrder.courierServiceName);
      const sfxResponse = await axios.post(
        `${SHADOWFAX_BASE_URL}/v3/clients/orders/`,
        sfxPayload,
        { headers, timeout: 30000 }
      );

      const sfxData = sfxResponse.data;

      if (sfxData.message !== "Success" || !sfxData.data?.awb_number) {
        const errorMsg =
          typeof sfxData.errors === "string"
            ? sfxData.errors
            : JSON.stringify(sfxData.errors || sfxData.message || "Failed to create Shadowfax order");
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ success: false, message: errorMsg });
      }

      // ── Deduct wallet ─────────────────────────────────────────────────────
      if (freightCharges > 0) {
        const newBalance = currentWallet.balance - freightCharges;
        await Wallet.findOneAndUpdate(
          { _id: currentWallet._id },
          {
            $inc: { balance: -freightCharges },
            $push: {
              transactions: {
                channelOrderId: currentOrder.orderId || null,
                category: "debit",
                amount: freightCharges,
                balanceAfterTransaction: newBalance,
                date: new Date(),
                awb_number: sfxData.data.awb_number,
                description: "Freight Charges Applied",
              },
            },
          },
          { session }
        );
      }

      // ── Update order document ─────────────────────────────────────────────
      currentOrder.awb_number = sfxData.data.awb_number;
      currentOrder.status = "Booked";
      currentOrder.provider = "Shadowfax";
      currentOrder.partner = "Shadowfax";
      currentOrder.tracking.push({
        status: "Booked",
        StatusLocation: sender.city || "",
        Instructions: "Order booked successfully",
        StatusDateTime: new Date(),
      });
      await currentOrder.save({ session });

      await session.commitTransaction();
      session.endSession();

      return res.status(200).json({
        success: true,
        message: "Order created successfully with Shadowfax.",
        awb_number: sfxData.data.awb_number,
        order: sfxData.data,
      });
    } catch (error) {
      await session.abortTransaction();
      session.endSession();

      if (
        error.errorLabels?.includes("TransientTransactionError") &&
        attempt < MAX_RETRIES
      ) {
        console.warn(`Shadowfax transient error on attempt ${attempt}, retrying…`);
        continue;
      }

      console.error("Shadowfax createOrder error:", error.message);
      return res.status(500).json({
        success: false,
        message: error.message || "Internal server error",
      });
    }
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// TRACK SHIPMENT
// GET /v4/clients/orders/{awb_number}/track/
// ─────────────────────────────────────────────────────────────────────────────
const trackShadowfaxOrder = async (awb_number, courierName) => {
  try {
    const headers = await getAuthHeaders(courierName);
    const response = await axios.get(
      `${SHADOWFAX_BASE_URL}/v4/clients/orders/${awb_number}/track/`,
      { headers, timeout: 15000 }
    );

    const sfxData = response.data;
    if (sfxData.message !== "Success" || !sfxData.tracking_details) {
      return { success: false, data: null };
    }

    // Shadowfax returns tracking_details as an array (oldest → newest)
    const trackingDetails = sfxData.tracking_details;
    if (!Array.isArray(trackingDetails) || trackingDetails.length === 0) {
      return { success: false, data: null };
    }

    return { success: true, data: trackingDetails };
  } catch (error) {
    console.error(
      `Shadowfax tracking error for AWB ${awb_number}:`,
      error.message
    );
    return { success: false, error: error.message };
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// CANCEL ORDER
// Shadowfax doesn't have a dedicated cancel endpoint in the public API;
// cancellation is done by setting status to "cancelled_by_seller".
// We call POST /v3/clients/orders/ with the same order_id to trigger it,
// or we mark it internally and rely on the Shadowfax portal/account manager.
// Best approach: return success so UI can mark order cancelled, 
// and the webhook will reflect the true state.
// ─────────────────────────────────────────────────────────────────────────────
const cancelShadowfaxOrder = async (awb_number, courierName) => {
  try {
    const headers = await getAuthHeaders(courierName);
    const response = await axios.post(
      `${SHADOWFAX_BASE_URL}/v3/clients/orders/cancel/`,
      {
        request_id: awb_number,
        cancel_remarks: "Cancelled by user"
      },
      { headers, timeout: 15000 }
    );

    if (response.data.message === "Success") {
      return { success: true, message: "Order cancelled successfully." };
    } else {
      return { 
        success: false, 
        message: response.data.errors ? JSON.stringify(response.data.errors) : (response.data.message || "Failed to cancel") 
      };
    }
  } catch (error) {
    console.error("Shadowfax cancelOrder error:", error.message);
    return { success: false, error: error.message };
  }
};

module.exports = {
  createOrder,
  trackShadowfaxOrder,
  cancelShadowfaxOrder,
  checkPincodeServiceability,
};
