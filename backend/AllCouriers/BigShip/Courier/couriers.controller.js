const axios = require("axios");
const FormData = require("form-data");
const Order = require("../../../models/newOrder.model");
const User = require("../../../models/User.model");
const Wallet = require("../../../models/wallet");
const PickupAddress = require("../../../models/pickupAddress.model");
const { bigShipRequest, getOrCreateBigShipWarehouse, getBigShipToken, timedBigShipCall } = require("../Authorize/bigship.controller");

const BASE_URL = process.env.BIGSHIP_URL || "https://api.bigship.direct";

// ================================================================
// REFERENCE DATA (payment modes / risk types) — fetched live and
// cached in memory rather than hardcoded, since the doc's inline
// payload comments ("1: Prepaid, 2: COD") are illustrative, not a
// guaranteed-stable contract for this account.
// ================================================================
const paymentModeCache = {}; // segmentType -> { [paymentModeName]: paymentModeId }
let riskTypeCache = null; // { [riskName]: riskTypeId }

const getPaymentModeId = async (segmentType, methodName) => {
  if (!paymentModeCache[segmentType]) {
    const res = await bigShipRequest("get", "/api/outbound/get-payment-mode", {
      params: { segment_type: segmentType },
    });
    const map = {};
    (res.data?.data || []).forEach((m) => {
      map[m.paymentModeName] = m.paymentModeId;
    });
    paymentModeCache[segmentType] = map;
  }
  const map = paymentModeCache[segmentType];
  return map[methodName] || map["Prepaid"];
};

const getRiskTypeId = async (riskName) => {
  if (!riskTypeCache) {
    const res = await bigShipRequest("get", "/api/outbound/domestic/risk-types");
    const map = {};
    (res.data?.data || []).forEach((r) => {
      map[r.riskName] = r.riskTypeId;
    });
    riskTypeCache = map;
  }
  return riskTypeCache[riskName] || riskTypeCache["Owner Risk"];
};

// ================================================================
// SERVICEABILITY (lightweight — via Rate Calculator, no draft order
// needed). Mirrors checkServiceabilityShipRocket's shape: returns
// { success, couriers } where couriers is the full list BigShip
// quoted for this route, so the caller can match a specific service
// name against it (same pattern as Shiprocket B2B's aggregator match).
// ================================================================
const checkServiceabilityBigShip = async ({
  segmentType, // "domestic_b2c" | "domestic_b2b"
  sourcePincode,
  destPincode,
  invoiceValue,
  paymentMethod, // "COD" | "Prepaid"
  riskName = "Owner Risk",
  boxes,
}) => {
  try {
    const [paymentModeId, riskTypeId] = await Promise.all([
      getPaymentModeId(segmentType, paymentMethod === "COD" ? "COD" : "Prepaid"),
      getRiskTypeId(riskName),
    ]);

    const payload = {
      segment_type: segmentType,
      sourcePincode,
      destPincode,
      invoiceValue,
      paymentModeId,
      riskTypeId,
      boxes,
    };
    if (paymentMethod === "COD") payload.codAmount = invoiceValue;

    const res = await bigShipRequest("post", "/api/outbound/user-rate-calculator", { data: payload });
    const couriers = res.data?.data || [];
    return { success: couriers.length > 0, couriers };
  } catch (error) {
    console.error("BigShip serviceability check failed:", error.response?.data || error.message);
    return { success: false, couriers: [] };
  }
};

// ================================================================
// BOOKING — 3 steps per BigShip's own design: draft order, fetch
// serviceable couriers for that draft, then place with a chosen
// courierId. Draft creation is cached on the order (otherDetails.
// bigshipOrderId) so re-opening the courier list doesn't re-draft.
// ================================================================

const buildBoxesPayload = (order, segmentType) => {
  const pkg = order.packageDetails;
  const dims = pkg?.volumetricWeight || {};
  if (segmentType === "domestic_b2c") {
    // Doc requires exactly one box entry for B2C.
    return [
      {
        weight_unit: "kg",
        dimension_unit: "cm",
        noOfBoxes: 1,
        dimensions: [
          {
            length: dims.length || 10,
            breadth: dims.width || 10,
            height: dims.height || 10,
            weight: pkg?.deadWeight || pkg?.applicableWeight || 0.5,
          },
        ],
      },
    ];
  }
  // domestic_b2b — one entry per B2BPackageDetails.packages group
  return (order.B2BPackageDetails?.packages || []).map((p) => ({
    weight_unit: "kg",
    dimension_unit: "cm",
    noOfBoxes: p.noOfBox || 1,
    dimensions: [
      {
        length: p.length || 10,
        breadth: p.width || 10,
        height: p.height || 10,
        weight: p.weightPerBox || 1,
      },
    ],
  }));
};

const createOrReuseDraftOrder = async (order, segmentType) => {
  if (order.otherDetails?.bigshipOrderId) {
    return order.otherDetails.bigshipOrderId;
  }

  const pickupAddressDoc = await PickupAddress.findOne({
    userId: order.userId,
    "pickupAddress.phoneNumber": order.pickupAddress.phoneNumber,
    "pickupAddress.pinCode": order.pickupAddress.pinCode,
  });
  if (!pickupAddressDoc) {
    throw new Error("No matching saved pickup address found for BigShip warehouse registration");
  }
  const warehouseId = await getOrCreateBigShipWarehouse(pickupAddressDoc);

  const boxes = buildBoxesPayload(order, segmentType);
  const isB2C = segmentType === "domestic_b2c";

  const basePayload = {
    segment_type: segmentType,
    MasterOrderPickUpLocation: Number(warehouseId),
    MasterOrderReturnLocation: Number(warehouseId),
    MasterOrderDate: new Date().toISOString().slice(0, 19).replace("T", " "),
    MasterOrderPaymentMode: order.paymentDetails?.method === "COD" ? 2 : 1,
    OrderInvoiceNo: String(order.orderId),
    MasterOrderInvoiceAmount: order.paymentDetails?.amount || 0,
    MasterOrderShippingEmail: order.receiverAddress?.email || "",
    MasterOrderShippingName: order.receiverAddress?.contactName,
    MasterOrderShippingMobileNo: order.receiverAddress?.phoneNumber,
    MasterOrderShippingAddress: order.receiverAddress?.address,
    MasterOrderShippingAddress2: "",
    MasterOrderShippingLandmark: order.receiverAddress?.city || "N/A",
    MasterOrderShippingZipCode: order.receiverAddress?.pinCode,
    MasterOrderShippingCountry: "India",
    MasterOrderShippingState: order.receiverAddress?.state,
    MasterOrderShippingCity: order.receiverAddress?.city,
    totalNumOfBoxes: boxes.reduce((sum, b) => sum + (b.noOfBoxes || 0), 0),
    boxes,
  };

  if (order.paymentDetails?.method === "COD") {
    basePayload.MasterOrderCollectableAmount = order.paymentDetails.amount;
  }

  if (isB2C) {
    // Products live inside each box entry per the doc's B2C payload shape.
    boxes.forEach((box) => {
      box.products = (order.productDetails || []).map((p) => ({
        productName: p.name,
        // HSN is free text in Delightcargo's product form, but a non-numeric
        // value here makes BigShip's create-order throw an unhandled 500
        // (confirmed live: "abc" -> 500, "1234" -> success) instead of a
        // proper validation error — so strip to digits only, and omit
        // entirely if nothing numeric is left (the doc marks it optional).
        hsn: (p.hsn || "").replace(/\D/g, ""),
        qty: String(p.quantity || 1),
        amount: String(p.unitPrice || 0),
        totalAmount: (Number(p.unitPrice) || 0) * (Number(p.quantity) || 1),
        collectableAmount: order.paymentDetails?.method === "COD"
          ? (Number(p.unitPrice) || 0) * (Number(p.quantity) || 1)
          : 0,
        categoryId: "1",
      }));
    });
  } else {
    basePayload.ProductName = (order.productDetails || [])[0]?.name || "General Goods";
  }

  const res = await bigShipRequest("post", "/api/outbound/create-order", { data: basePayload });
  if (!res.data?.status || !res.data?.data?.CustomGlobalOrderId) {
    throw new Error(res.data?.message || "BigShip draft order creation failed");
  }

  const bigshipOrderId = String(res.data.data.CustomGlobalOrderId);
  // console.log("Bigship order id",bigshipOrderId)
  await Order.updateOne(
    { _id: order._id },
    { $set: { "otherDetails.bigshipOrderId": bigshipOrderId } }
  );
  return bigshipOrderId;
};

// Step 2: given a drafted order, get BigShip's serviceable couriers + their
// live quotes. Used only as a serviceability/courierId signal — the price
// shown to the customer comes from Delightcargo's own rate card, not this.
const getBigShipCourierOptions = async (order, segmentType) => {
  const bigshipOrderId = await createOrReuseDraftOrder(order, segmentType);
  const res = await bigShipRequest("post", "/api/outbound/courier-wise-shipment-cost", {
    data: { MasterCustomOrderId: bigshipOrderId },
  });
  if (!res.data?.status) {
    throw new Error(res.data?.message || "Failed to fetch BigShip courier options");
  }
  return {
    bigshipOrderId,
    couriers: res.data.data?.calculatedRates || [],
  };
};

// Step 3: final booking with the chosen courierId.
const placeBigShipOrder = async (order, bigshipOrderId, courierId, { invoiceFile, ewaybillNo, ewaybillFile, riskTypeId } = {}) => {
  let payload;
  let headers = {};

  // riskTypeId is required by place-order for both B2B and B2C (confirmed
  // live: "The risk type id field is required." when omitted) — it was only
  // ever being appended in the file-upload branch below, so a plain B2C/
  // sub-50k-B2B booking (the common case, no invoice/ewaybill file) never
  // sent it at all.
  if (invoiceFile || ewaybillFile) {
    const form = new FormData();
    form.append("MasterCustomOrderId", bigshipOrderId);
    form.append("courierId", String(courierId));
    form.append("invoiceType", "uploaded");
    if (invoiceFile) form.append("InvoiceData", invoiceFile.buffer, invoiceFile.originalname);
    if (ewaybillNo) form.append("EwaybillNo", ewaybillNo);
    if (ewaybillFile) form.append("EwayBillData", ewaybillFile.buffer, ewaybillFile.originalname);
    form.append("riskTypeId", String(riskTypeId));
    payload = form;
    headers = form.getHeaders();
  } else {
    payload = { MasterCustomOrderId: bigshipOrderId, courierId: String(courierId), riskTypeId: String(riskTypeId) };
  }

  const token = await getBigShipToken();

  const res = await timedBigShipCall("POST /api/outbound/place-order", () =>
    axios.post(`${BASE_URL}/api/outbound/place-order`, payload, {
      headers: { ...headers, Authorization: `Bearer ${token}` },
      timeout: 20000,
    })
  );

  if (!res.data?.status) {
    throw new Error(res.data?.message || "BigShip order placement failed");
  }
  return res.data.data; // { reference_number, awb_assigned }
};

const cancelBigShipOrder = async (bigshipOrderId) => {
  try {
    const res = await bigShipRequest("post", "/api/outbound/cancel-order", {
      data: { CustomGlobalOrderId: bigshipOrderId },
    });
    if (!res.data?.status) {
      return { error: res.data?.message || "BigShip cancellation failed" };
    }
    return { success: true };
  } catch (error) {
    return { error: error.response?.data?.message || error.message };
  }
};

const trackBigShipOrder = async (bigshipOrderId) => {
  const res = await bigShipRequest("get", "/api/outbound/track-order", {
    params: { CustomGlobalOrderId: bigshipOrderId },
  });
  if (!res.data?.status) return null;
  return res.data.data;
};

// Admin "Add Courier Service" dropdown — BigShip has no "list everything my
// account can do" endpoint, only the route-specific Rate Calculator, so this
// uses a fixed Delhi<->Mumbai reference route as a representative check
// (same reasoning/pattern as the B2B equivalent, getBigShipCourierServices
// in B2B/controller/Couriers/couriers.controller.js).
const getAllActiveCourierServicesBigShip = async (req, res) => {
  try {
    const result = await checkServiceabilityBigShip({
      segmentType: "domestic_b2c",
      sourcePincode: "110001",
      destPincode: "400001",
      invoiceValue: 2000,
      paymentMethod: "Prepaid",
      boxes: [{ no_of_box: "1", box_length: "20", box_width: "15", box_height: "10", box_dead_weight: "1" }],
    });
    return res.status(200).json(result.couriers.map((c) => c.courierName));
  } catch (error) {
    console.error("Error fetching live BigShip courier services:", error.response?.data || error.message);
    return res.status(500).json([]);
  }
};

// ================================================================
// SHIPMENT CREATION (B2C) — mirrors createShiprocketShipment's
// transaction + wallet-debit + retry-on-write-conflict structure,
// adapted for BigShip's 3-step draft → courier options → place flow.
// Kept in this same file (rather than a separate API/Courier/*
// creation controller like Shiprocket's) specifically to avoid a
// circular require: this needs createOrReuseDraftOrder/
// getBigShipCourierOptions/placeBigShipOrder defined above.
// ================================================================
const createBigShipShipment = async ({
  id,
  finalCharges,
  courierServiceName,
  courier, // exact BigShip courierName this rate-card service maps to
  priceBreakup,
  walletId,
  walletBalance,
  walletHoldAmount,
  walletCreditLimit,
}) => {
  const mongoose = require("mongoose");
  const { getZone } = require("../../../Rate/zoneManagementController");
  const estimatedDeliveryDate = require("../../../models/EDDMap.model");
  const { assignPickupManifest } = require("../../../Orders/scheduledPickup.controller");
  const WalletTransaction = require("../../../models/WalletTransaction.model");
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // ── PHASE 1: lock the order + validate, in a short transaction ──────────
  // No external calls in here at all — this used to wrap the entire flow,
  // including BigShip's 3 sequential HTTP calls (5+ seconds just for
  // courier-wise-shipment-cost). Holding a Mongo transaction open that long
  // is exactly what made write conflicts routine rather than rare — this
  // phase now commits in milliseconds, so the odds of colliding with any
  // other write on the same documents drop back to what they should be.
  let currentOrder, zone, estimateDate, balanceToBeDeducted;
  {
    const maxRetries = 3;
    let attempt = 0;
    let lockResult = null;

    while (attempt < maxRetries && !lockResult) {
      attempt++;
      const session = await mongoose.startSession();
      try {
        session.startTransaction();

        currentOrder = await Order.findOneAndUpdate(
          { _id: id, status: "new" },
          { $set: { status: "processing" } },
          { new: true, session }
        );

        if (!currentOrder) {
          await session.abortTransaction();
          session.endSession();
          return { success: false, message: "Shipment already created or order not in 'new' status." };
        }

        if (!walletId) {
          await session.abortTransaction();
          session.endSession();
          return { success: false, message: "Wallet not found" };
        }

        const effectiveBalance = walletBalance - (walletHoldAmount || 0);
        balanceToBeDeducted = parseFloat(finalCharges) || 0;
        const totalBalance = effectiveBalance + (walletCreditLimit || 0);

        if (totalBalance < balanceToBeDeducted) {
          await session.abortTransaction();
          session.endSession();
          return { success: false, message: "Insufficient Wallet Balance" };
        }

        zone = await getZone(currentOrder.pickupAddress.pinCode, currentOrder.receiverAddress.pinCode);
        if (!zone) {
          await session.abortTransaction();
          session.endSession();
          return { success: false, message: "Pincode not serviceable" };
        }

        const eddData = await estimatedDeliveryDate.findOne({
          courier: "BigShip",
          serviceName: courierServiceName.trim(),
        });
        estimateDate = null;
        if (eddData) {
          const deliveryDays = eddData.zoneRates?.[zone.zone] || eddData[zone.zone];
          if (typeof deliveryDays === "number") {
            estimateDate = new Date();
            estimateDate.setDate(estimateDate.getDate() + deliveryDays);
          }
        }

        await session.commitTransaction();
        session.endSession();
        lockResult = true;
      } catch (error) {
        if (session.inTransaction()) await session.abortTransaction();
        session.endSession();

        const isTransient =
          error.errorLabels?.includes("TransientTransactionError") ||
          error.code === 112 ||
          error.message?.includes("WriteConflict");

        if (isTransient && attempt < maxRetries) {
          console.warn(`[BigShip createShipment] Write conflict locking order on attempt ${attempt}. Retrying in ${50 * attempt}ms...`);
          await sleep(50 * attempt);
          continue;
        }

        console.error("BigShip Creation Error (lock phase):", error.response?.data || error.message);
        return { success: false, message: error.response?.data?.message || error.message || "Error creating shipment" };
      }
    }
  }

  // ── PHASE 2: the slow external calls — no DB transaction held here ──────
  // Nothing external has happened yet at this point, so on any failure it's
  // always safe to just revert the order back to "new" (a plain, single-
  // document update — no transaction needed for that).
  const revertToNew = () => Order.updateOne({ _id: id }, { $set: { status: "new" } }).catch(() => {});

  let bigshipOrderId, courierOptions, matchedCourier;
  try {
    ({ bigshipOrderId, couriers: courierOptions } = await getBigShipCourierOptions(currentOrder, "domestic_b2c"));
  } catch (err) {
    await revertToNew();
    return { success: false, message: err.response?.data?.message || err.message || "BigShip order/rate fetch failed" };
  }

  matchedCourier = courierOptions.find((c) => c.courierName === courier);
  if (!matchedCourier) {
    await revertToNew();
    return { success: false, message: `BigShip no longer has "${courier}" serviceable on this route.` };
  }

  let placeResult;
  try {
    // B2C has no rovType concept — defaults to Owner Risk, same as the
    // fallback used everywhere else riskName isn't specified.
    const riskTypeId = await getRiskTypeId("Owner Risk");
    placeResult = await placeBigShipOrder(currentOrder, bigshipOrderId, matchedCourier.courierId, { riskTypeId });
  } catch (err) {
    await revertToNew();
    return { success: false, message: err.response?.data?.message || err.message || "BigShip order placement failed" };
  }

  const awb_number = String(placeResult.awb_assigned || placeResult.reference_number || "");
  if (!awb_number) {
    await revertToNew();
    return { success: false, message: "BigShip did not return an AWB number." };
  }

  // ── PHASE 3: point of no return reached — persist, never touch BigShip
  // again regardless of what happens here. A short, pure-DB transaction, so
  // conflicts are rare — and even if one occurs, retrying just this step is
  // always safe (nothing external can be re-triggered by it).
  let persisted = false;
  for (let attempt = 1; attempt <= 3 && !persisted; attempt++) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      await Promise.all([
        Order.findByIdAndUpdate(
          id,
          {
            $set: {
              status: "Booked",
              awb_number,
              provider: matchedCourier.courierName || "BigShip",
              partner: "BigShip",
              totalFreightCharges: balanceToBeDeducted,
              courierServiceName,
              shipmentCreatedAt: new Date(),
              zone: zone.zone,
              estimatedDeliveryDate: estimateDate,
              priceBreakup,
              "otherDetails.bigshipOrderId": bigshipOrderId,
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
        Wallet.updateOne({ _id: walletId }, { $inc: { balance: -balanceToBeDeducted } }, { session }),
        WalletTransaction.create(
          [
            {
              walletId,
              channelOrderId: currentOrder.orderId || null,
              category: "debit",
              amount: balanceToBeDeducted,
              balanceAfterTransaction: walletBalance - balanceToBeDeducted,
              date: new Date(),
              awb_number,
              description: "Freight Charges Applied",
              priceBreakup,
            },
          ],
          { session }
        ),
      ]);
      await session.commitTransaction();
      session.endSession();
      persisted = true;
    } catch (error) {
      if (session.inTransaction()) await session.abortTransaction();
      session.endSession();
      if (attempt === 3) {
        console.error(
          `[BigShip createShipment] CRITICAL: AWB ${awb_number} (BigShip order ${bigshipOrderId}) was placed but could not be saved after 3 attempts — needs manual reconciliation:`,
          error.message
        );
      } else {
        console.warn(`[BigShip createShipment] Write conflict persisting AWB ${awb_number} on attempt ${attempt}. Retrying in ${50 * attempt}ms...`);
        await sleep(50 * attempt);
      }
    }
  }

  process.nextTick(async () => {
    try {
      const fresh = await Order.findById(id);
      if (fresh) await assignPickupManifest(fresh);
    } catch (e) {}
  });

  // Success is reported based on BigShip's own confirmation, not on whether
  // phase 3 fully persisted — the shipment is real either way, and a rare
  // phase-3 failure after 3 retries is a logged reconciliation issue, not a
  // reason to tell the customer their booking failed when it didn't.
  return {
    success: true,
    message: "Shipment Created Successfully",
    orderId: currentOrder.orderId,
    awb_number,
  };
};

// Express handler — matches Shiprocket's createCustomOrder(req,res) shape,
// called from POST /BigShip/createShipment when the user picks a BigShip
// service on the courier-selection screen.
const createCustomOrderBigShip = async (req, res) => {
  try {
    const { id, finalCharges, courierServiceName, courier, priceBreakup } = req.body;

    const order = await Order.findById(id);
    if (!order) return res.status(404).json({ success: false, message: "Order not found" });

    const user = await User.findById(order.userId);
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    const wallet = await Wallet.findById(user.Wallet).select("balance holdAmount creditLimit");
    if (!wallet) return res.status(404).json({ success: false, message: "Wallet not found" });

    const result = await createBigShipShipment({
      id,
      finalCharges,
      courierServiceName,
      courier,
      priceBreakup,
      walletId: user.Wallet,
      walletBalance: wallet.balance,
      walletHoldAmount: wallet.holdAmount || 0,
      walletCreditLimit: wallet.creditLimit || 0,
    });

    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

// ================================================================
// TRACKING — deliberately self-contained rather than feeding into
// this app's shared mapTrackingResponse pipeline (Orders/tracking.
// controller.js), which is built around each provider's own raw
// response shape via bespoke per-provider branches. BigShip's shape
// (tag/order_status/tracking_histories) doesn't match any of those,
// and several other providers already get this same early-branch,
// bypass-the-shared-pipeline treatment for the same reason. Mirrors
// the B2B Shiprocket Cargo tracker's status-mapping approach.
// ================================================================
const KNOWN_BIGSHIP_STATUS_MAP = {
  "delivered": "Delivered",
  "in-transit": "In-transit",
  "out for delivery": "Out For Delivery",
  "picked up": "In-transit",
  "order placed": "Booked",
};

const mapBigShipStatus = (rawStatus) => {
  if (!rawStatus) return null;
  const normalized = String(rawStatus).trim().toLowerCase();
  if (KNOWN_BIGSHIP_STATUS_MAP[normalized]) return KNOWN_BIGSHIP_STATUS_MAP[normalized];

  if (normalized.includes("rto")) {
    if (normalized.includes("deliver")) return "RTO Delivered";
    if (normalized.includes("transit")) return "RTO In-transit";
    return "RTO";
  }
  if (normalized.includes("cancel")) return "Cancelled";
  if (normalized.includes("lost")) return "Lost";
  if (normalized.includes("damage")) return "Damaged";
  if (normalized.includes("deliver")) return "Delivered";
  if (normalized.includes("transit")) return "In-transit";

  return null;
};

// Fetches the latest status for one BigShip order and updates it if changed.
// Called from Orders/tracking.controller.js's trackSingleOrder for orders
// with partner === "BigShip", bypassing the shared normalization pipeline.
const refreshBigShipOrderTracking = async (order) => {
  const bigshipOrderId = order.otherDetails?.bigshipOrderId;
  if (!bigshipOrderId) return;

  const data = await trackBigShipOrder(bigshipOrderId);
  if (!data) return;

  const mappedStatus = mapBigShipStatus(data.order_status || data.tag);
  if (!mappedStatus) {
    console.warn(
      `[BigShip Tracking] Order ${order.orderId} (AWB ${order.awb_number}): unrecognized status "${data.order_status}" — not updating status.`
    );
    return;
  }

  const update = {};
  if (mappedStatus !== order.status) {
    update.$set = { status: mappedStatus };
    const latestHistory = data.tracking_histories?.[0];
    update.$push = {
      tracking: {
        status: mappedStatus,
        Instructions: latestHistory?.message || data.order_status || "Status updated",
        StatusDateTime: new Date(Date.now() + 5.5 * 60 * 60 * 1000),
      },
    };
  }

  if (Object.keys(update).length > 0) {
    await Order.findByIdAndUpdate(order._id, update);
  }
};

module.exports = {
  checkServiceabilityBigShip,
  getAllActiveCourierServicesBigShip,
  createOrReuseDraftOrder,
  getBigShipCourierOptions,
  placeBigShipOrder,
  cancelBigShipOrder,
  trackBigShipOrder,
  createBigShipShipment,
  refreshBigShipOrderTracking,
  createCustomOrderBigShip,
  getPaymentModeId,
  getRiskTypeId,
};
