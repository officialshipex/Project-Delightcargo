const { refreshToken } = require("../Authorize/delhivery.controller");
const BASE_URL = process.env.DEL_URL;
const axios = require("axios");
const User = require("../../../../../../models/User.model");
const Wallet = require("../../../../../../models/wallet");
const WalletTransaction = require("../../../../../../models/WalletTransaction.model");
const mongoose = require("mongoose");
const Order = require("../../../../../../models/newOrder.model");
const crypto = require("crypto");

const createdDelhiveryB2BWarehouses = new Set();

// Helper function to generate a unique warehouse name for Delhivery
const getUniqueWarehouseName = (payload) => {
  const address = payload?.address || payload?.addressLine1 || "";
  const pinCode = payload?.pinCode || "";
  const phoneNumber = payload?.phoneNumber || payload?.contactNo || "";
  const contactName = payload?.contactName || "Default Warehouse";

  if (!address) return contactName;

  const addressKey = `${address}-${pinCode}-${phoneNumber}`
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  const hash = crypto
    .createHash("md5")
    .update(addressKey)
    .digest("hex")
    .substring(0, 6);
  return `${contactName.substring(0, 30)}-${hash}`.trim();
};

const createClientWarehouseB2B = async (payload, token) => {
  if (!payload) {
    throw new Error("Payload is required to create a warehouse.");
  }

  const uniqueName = getUniqueWarehouseName(payload);

  if (createdDelhiveryB2BWarehouses.has(uniqueName)) {
    return {
      success: true,
      message: "Warehouse already exists (cached), proceeding",
      name: uniqueName,
    };
  }

  const phone = payload.phoneNumber || payload.contactNo || "";
  const address = payload.address || payload.addressLine1 || "";

  let expressUrl = process.env.DELHIVERY_URL || "https://track.delhivery.com";
  if (BASE_URL && BASE_URL.includes("-dev")) {
    expressUrl = "https://staging-express.delhivery.com";
  }

  const warehouseDetails = {
    name: uniqueName,
    address: address,
    city: payload.city,
    state: payload.state,
    country: "India",
    pin: payload.pinCode,
    phone: phone,
  };

  try {
    const response = await axios.post(
      `${expressUrl}/b2b/api/v1/clientwarehouse/create/`,
      warehouseDetails,
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      }
    );

    if (response.data.success || response.data.status === "success") {
      createdDelhiveryB2BWarehouses.add(uniqueName);
      return {
        success: true,
        message: "B2B Warehouse created successfully",
        name: uniqueName,
        data: response.data,
      };
    } else {
      const errorMessage = response.data.error?.[0] || response.data.message || "";
      if (errorMessage.includes("already exists")) {
        createdDelhiveryB2BWarehouses.add(uniqueName);
        return {
          success: true,
          message: "B2B Warehouse already exists, proceeding",
          name: uniqueName,
          data: response.data,
        };
      } else {
        throw new Error(errorMessage || "B2B Warehouse creation failed.");
      }
    }
  } catch (error) {
    const errorMessage = error.response?.data?.error?.[0] || error.response?.data?.message || "";
    if (errorMessage.includes("already exists")) {
      createdDelhiveryB2BWarehouses.add(uniqueName);
      return {
        success: true,
        message: "B2B Warehouse already exists, proceeding",
        name: uniqueName,
      };
    } else {
      console.error(
        "Error creating B2B warehouse:",
        error.response?.data || error.message
      );
      throw new Error(errorMessage || "Failed to create B2B warehouse.");
    }
  }
};

const createDelhiveryB2BShipment = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    const { id, provider, courierServiceName, finalCharges, rateBreakup } = req.body;
    console.log("Creating Delhivery B2B Shipment for Order ID:", req.body);

    session.startTransaction();

    /* ================================
       1️⃣ LOCK ORDER
    ================================= */
    const order = await Order.findOneAndUpdate(
      { _id: id, status: "new" },
      { $set: { status: "processing" } },
      { new: true, session }
    );

    if (!order) throw new Error("Order already processed");
    if (order.orderType !== "B2B")
      throw new Error("Delhivery supports B2B only");

    /* ================================
       2️⃣ WALLET CHECK
    ================================= */
    const user = await User.findById(order.userId).session(session);
    const wallet = await Wallet.findById(user.Wallet).select("balance holdAmount creditLimit").session(session);

    const effectiveBalance = wallet.balance - (wallet.holdAmount || 0);
    const balance = effectiveBalance + wallet.creditLimit;

    if (balance < finalCharges) throw new Error("Insufficient Wallet Balance");

    /* ================================
       3️⃣ WALLET DEBIT
    ================================= */
    const newBalance = wallet.balance - Number(finalCharges);

    await Promise.all([
      Wallet.findByIdAndUpdate(
        user.Wallet,
        {
          $inc: { balance: -finalCharges },
        },
        { session }
      ),
      await WalletTransaction.create([
        {
          walletId: user.Wallet,
          channelOrderId: order.orderId,
          category: "debit",
          amount: finalCharges,
          balanceAfterTransaction: newBalance,
          description: "Freight Charges Applied",
          date: new Date(),
        }
      ], { session })
    ]);

    /* ================================
       4️⃣ MANIFEST PAYLOAD
    ================================= */
    const totalWeight = order.B2BPackageDetails.packages.reduce(
      (s, p) => s + p.noOfBox * p.weightPerBox,
      0
    );

    const token = await refreshToken(courierServiceName || order.courierServiceName);

    // Register/Create the B2B client warehouse if needed
    const warehouseResult = await createClientWarehouseB2B(order.pickupAddress, token);
    const pickupWarehouseName = warehouseResult.name || getUniqueWarehouseName(order.pickupAddress);

    const form = new FormData();

    form.append("pickup_location_name", pickupWarehouseName);
    form.append("payment_mode", order.paymentDetails.method.toLowerCase());
    form.append(
      "cod_amount",
      order.paymentDetails.method === "COD" ? order.paymentDetails.amount : 0
    );
    // Weight needs to be in grams for Delhivery B2B Create LR API
    form.append("weight", totalWeight * 1000);
    form.append("rov_insurance", order.rovType?.toLowerCase().includes("carrier") ? true : false);
    form.append("freight_mode", "fop");
    form.append("fm_pickup", true);

    const publicUrl = process.env.BACKEND_PUBLIC_URL || "https://api.delightcargo.in";
    const webhookSecret = process.env.DELHIVERY_WEBHOOK_SECRET || process.env.DELHIVERY_WEBHOOK_TOKEN;

    /* 🔔 CALLBACK CONFIG */
    form.append(
      "callback",
      JSON.stringify({
        uri: `${publicUrl}/v1/webhook/delhivery/manifest`,
        method: "POST",
        authorization: `Bearer ${webhookSecret}`,
        headers: { "Content-Type": "application/json" },
      })
    );

    form.append(
      "dropoff_location",
      JSON.stringify({
        consignee_name: order.receiverAddress.contactName,
        address: order.receiverAddress.address,
        city: order.receiverAddress.city,
        state: order.receiverAddress.state,
        zip: order.receiverAddress.pinCode,
        phone: order.receiverAddress.phoneNumber,
        email: order.receiverAddress.email || "",
      })
    );

    form.append(
      "invoices",
      JSON.stringify([
        {
          ewaybill: order.otherDetails?.ewaybill || "",
          inv_num: `INV-${order.orderId}`,
          inv_amt: order.paymentDetails.amount,
          inv_date: new Date().toISOString().split("T")[0],
          inv_qr_code: "",
        },
      ])
    );

    form.append(
      "shipment_details",
      JSON.stringify(
        order.B2BPackageDetails.packages.map((pkg, i) => ({
          order_id: `${order.orderId}-${i + 1}`,
          box_count: pkg.noOfBox,
          description: "B2B Cargo",
          weight: pkg.noOfBox * pkg.weightPerBox * 1000, // weight in grams
          waybills: [],
          master: false,
        }))
      )
    );

    form.append(
      "billing_address",
      JSON.stringify({
        name: order.pickupAddress.contactName,
        company: order.pickupAddress.contactName,
        consignor: order.pickupAddress.contactName,
        address: order.pickupAddress.address,
        city: order.pickupAddress.city,
        state: order.pickupAddress.state,
        pin: order.pickupAddress.pinCode,
        phone: order.pickupAddress.phoneNumber,
        gst_number: order.otherDetails?.gstin || "",
      })
    );

    /* ================================
       5️⃣ MANIFEST API CALL
    ================================= */
    const manifestRes = await axios.post(`${BASE_URL}/manifest`, form, {
      headers: {
        Authorization: `Bearer ${token}`,
        ...form.getHeaders(),
      },
    });

    const jobId = manifestRes.data?.job_id;
    if (!jobId) throw new Error("Delhivery manifest failed");

    /* ================================
       6️⃣ SAVE ORDER
    ================================= */
    await Order.findByIdAndUpdate(
      order._id,
      {
        $set: {
          status: "Booked",
          provider: provider || "Delhivery",
          courierServiceName,
          manifestJobId: jobId,
          totalFreightCharges: finalCharges,
          rateBreakup,
          walletDeducted: true,
        },
        $push: {
          tracking: {
            status: "Booked",
            Instructions: "Delhivery manifest created",
            StatusDateTime: new Date(),
          },
        },
      },
      { session }
    );

    await session.commitTransaction();
    session.endSession();

    res.json({ success: true, job_id: jobId });

    /* ================================
       7️⃣ ASYNC STATUS CHECK FALLBACK
    ================================= */
    setTimeout(
      () => getDelhiveryB2BShipmentDetailsInternal(jobId),
      60 * 1000
    );
  } catch (err) {
    console.error("Error in Delhivery B2B Shipment:", err.response?.data || err.message);
    await session.abortTransaction();
    session.endSession();

    await Order.findByIdAndUpdate(req.body.id, { status: "new" });

    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

const getDelhiveryB2BShipmentDetailsInternal = async (jobId) => {
  try {
    const order = await Order.findOne({ manifestJobId: jobId });
    if (!order) return;

    if (order.awb_number && order.status === "Ready To Ship") return;

    const token = await refreshToken(order.courierServiceName || order.provider);

    const response = await axios.get(
      `${BASE_URL}/manifest`,
      {
        params: { job_id: jobId },
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    console.log("Delhivery Cargo Job Details:", response.data);
    const data = response.data;
    const status = data.status || data.state;
    
    const user = await User.findById(order.userId);
    const wallet = await Wallet.findById(user.Wallet).select("balance holdAmount creditLimit");

    /* ================================
       ❌ SHIPMENT FAILED → REFUND
    ================================= */
    if (status === "FAILED" || status === "FAILED_MANIFEST") {
      if (order.walletDeducted && !order.walletRefunded) {
        const refundAmount = Number(order.totalFreightCharges);
        const newBalance = wallet.balance + refundAmount;
        
        await Wallet.findByIdAndUpdate(user.Wallet, {
          $set: { balance: newBalance },
        });

        await WalletTransaction.create([{
          walletId: user.Wallet,
          category: "credit",
          channelOrderId: order.orderId,
          amount: refundAmount,
          balanceAfterTransaction: newBalance,
          description: "Freight Charges Received",
          date: new Date(),
        }]);

        await Order.findByIdAndUpdate(order._id, {
          walletRefunded: true,
          status: "Cancelled",
          $push: {
            tracking: {
              status: "Cancelled",
              Instructions: data.error || data.remarks || "Delhivery manifest failed",
              StatusDateTime: new Date(),
            },
          },
        });
      }
      return;
    }

    /* ================================
       ✅ SUCCESS → SAVE AWB + CHILD AWBs
    ================================= */
    if (status === "SUCCESS") {
      const awb = data.awbs?.[0] || data.waybill_number || data.awb || null;
      const awbList = data.awbs || (awb ? [awb] : []);
      
      await Order.findByIdAndUpdate(order._id, {
        $set: {
          awb_number: awb,
          lrn: data.lrn,
          child_awb_numbers: awbList,
          status: "Ready To Ship",
        },
        $push: {
          tracking: {
            status: "Ready To Ship",
            Instructions: "LR & AWB generated by Delhivery",
            StatusDateTime: new Date(),
          },
        },
      });

      await WalletTransaction.updateOne(
        {
          walletId: user.Wallet,
          channelOrderId: order.orderId,
          category: "debit"
        },
        {
          $set: {
            awb_number: awb
          }
        }
      ).catch(e => console.error("⚠️ WalletTransaction Delhivery B2B AWB update failed:", e.message));
    }
  } catch (err) {
    console.error("Delhivery B2B async check error:", err.message);
  }
};

const createDelhiveryPickupRequest = async (order) => {
  try {
    const token = await refreshToken(order.courierServiceName || order.provider);

    const packageCount =
      order.B2BPackageDetails?.packages?.reduce(
        (sum, pkg) => sum + Number(pkg.noOfBox || 0),
        0
      ) || 1;

    const response = await axios.post(
      `${BASE_URL}/pickup_requests`,
      {
        client_warehouse: order.pickupAddress?.contactName,
        pickup_date: new Date().toISOString().split("T")[0],
        start_time: "05:00:00",
        expected_package_count: packageCount,
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    return {
      success: true,
      provider: "delhivery",
      orderId: order._id,
      data: response.data,
    };
  } catch (error) {
    return {
      success: false,
      provider: "delhivery",
      orderId: order._id,
      error: error?.response?.data || error.message,
    };
  }
};

const delhiveryManifestCallback = async (req, res) => {
  try {
    /* ================================
       🔐 AUTH VALIDATION
    ================================= */
    const expectedAuth = `Bearer ${process.env.DELHIVERY_WEBHOOK_SECRET || process.env.DELHIVERY_WEBHOOK_TOKEN}`;
    if (req.headers.authorization !== expectedAuth) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const payload = req.body;

    const order = await Order.findOne({
      manifestJobId: payload.job_id,
    });

    if (!order) return res.json({ success: true });

    const user = await User.findById(order.userId);
    const wallet = await Wallet.findById(user.Wallet).select("balance holdAmount creditLimit");

    /* ================================
       ❌ FAILED → REFUND
    ================================= */
    if (payload.status === "FAILED") {
      if (order.walletDeducted && !order.walletRefunded) {
        const refundAmount = order.totalFreightCharges;
        const newBalance = wallet.balance + refundAmount;

        await Wallet.findByIdAndUpdate(user.Wallet, {
          $set: { balance: newBalance },
        });

        await WalletTransaction.create([{
          walletId: user.Wallet,
          category: "credit",
          channelOrderId: order.orderId,
          amount: refundAmount,
          balanceAfterTransaction: newBalance,
          description: "Freight Charges Received",
          date: new Date(),
        }]);

        await Order.findByIdAndUpdate(order._id, {
          status: "Cancelled",
          walletRefunded: true,
          $push: {
            tracking: {
              status: "Cancelled",
              Instructions: payload.error || "Delhivery manifest failed",
              StatusDateTime: new Date(),
            },
          },
        });
      }

      return res.json({ success: true });
    }

    /* ================================
       ✅ SUCCESS → SAVE LR + AWBs
    ================================= */
    if (payload.status === "SUCCESS") {
      await Order.findByIdAndUpdate(order._id, {
        $set: {
          lrn: payload.lrn,
          awb_number: payload.awbs?.[0] || null,
          child_awb_numbers: payload.awbs || [],
          status: "Ready To Ship",
        },
        $push: {
          tracking: {
            status: "Ready To Ship",
            Instructions: "LR & AWB generated by Delhivery",
            StatusDateTime: new Date(),
          },
        },
      });

      await WalletTransaction.updateOne(
        {
          walletId: user.Wallet,
          channelOrderId: order.orderId,
          category: "debit"
        },
        {
          $set: {
            awb_number: payload.awbs?.[0] || null
          }
        }
      ).catch(e => console.error("⚠️ WalletTransaction B2B AWB update failed:", e.message));
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Delhivery Callback Error:", err.message);
    res.json({ success: true });
  }
};

const checkDelhiveryServiceability = async ({ order, packages }) => {
  try {
    const accessToken = await refreshToken(order.courierServiceName || order.provider);
    if (!accessToken) {
      throw new Error("Delhivery access token missing");
    }

    const pickupPincode = order.pickupAddress.pinCode;
    const deliveryPincode = order.receiverAddress.pinCode;

    let expressUrl = process.env.DELHIVERY_URL || "https://track.delhivery.com";
    if (BASE_URL && BASE_URL.includes("-dev")) {
      expressUrl = "https://staging-express.delhivery.com";
    }

    const response = await axios.get(
      `${expressUrl}/b2b/api/v1/pincode/serviceability/`,
      {
        params: {
          o_pin: pickupPincode,
          d_pin: deliveryPincode,
        },
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    const data = response.data;
    if (data && (data.serviceable === true || data.success === true || data.serviceability === true)) {
      return true;
    }

    return false;
  } catch (error) {
    console.error(
      "Delhivery Serviceability Error:",
      error.response?.data || error.message
    );
    return false;
  }
};

module.exports = {
  createDelhiveryB2BShipment,
  createDelhiveryPickupRequest,
  delhiveryManifestCallback,
  checkDelhiveryServiceability,
};
