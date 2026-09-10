const mongoose = require("mongoose");
const Order = require("../../../../../../models/newOrder.model");
const User = require("../../../../../../models/User.model");
const Wallet = require("../../../../../../models/wallet");
const WalletTransaction = require("../../../../../../models/WalletTransaction.model");
const CourierServiceB2B = require("../../../../../models/courierService.model");
const { getAuthoritativeB2BRate } = require("../../../../../utils/b2bRateEngine");
const {
  checkServiceabilityBigShip,
  getBigShipCourierOptions,
  placeBigShipOrder,
  getRiskTypeId,
} = require("../../../../../../AllCouriers/BigShip/Courier/couriers.controller");

// B2B-facing serviceability wrapper — same underlying BigShip Rate Calculator
// call as B2C, just segment_type: "domestic_b2b" and shaped to match this
// app's B2B "aggregator" serviceability contract (checkB2BServiceability in
// ShipNowB2BOrder.controller.js), the same shape Shiprocket Cargo returns.
const getBigShipServiceableCouriers = async ({ order, packages }) => {
  const boxes = (packages || order.B2BPackageDetails?.packages || []).map((p) => ({
    no_of_box: String(p.noOfBox || 1),
    box_length: String(p.length || 10),
    box_width: String(p.width || 10),
    box_height: String(p.height || 10),
    box_dead_weight: String(p.weightPerBox || 1),
  }));

  const result = await checkServiceabilityBigShip({
    segmentType: "domestic_b2b",
    sourcePincode: order.pickupAddress.pinCode,
    destPincode: order.receiverAddress.pinCode,
    invoiceValue: order.paymentDetails?.amount || 0,
    paymentMethod: order.paymentDetails?.method,
    boxes,
  });

  if (!result.success) return [];

  // Shape matches Shiprocket Cargo's getCargoServiceableCouriers: [{key, isODA}]
  // — key = the courier's name (matched against courierService.courier),
  // isODA derived from BigShip's own oda charge for this route/courier.
  return result.couriers.map((c) => ({
    key: c.courierName,
    isODA: parseFloat(c.oda) > 0,
    courierId: c.courier_partner_id,
  }));
};

/* ================================================================
   BOOKING — mirrors createShiprocketCargoShipment's structure
   (order lock, server-side authoritative rate recompute so a client
   can never dictate what the wallet gets debited, transaction-wrapped
   wallet debit), adapted for BigShip's 3-step draft → courier options
   → place flow with an explicit user-chosen courier (Shiprocket Cargo
   auto-assigns, so it never needed this step).
================================================================= */
const createBigShipCargoShipment = async (req, res) => {
  const { id, courierServiceName } = req.body;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // ── PHASE 1: lock the order, in a short transaction ──────────────────────
  // No external calls in here — this used to wrap the entire flow, including
  // BigShip's 3 sequential HTTP calls (5+ seconds just for
  // courier-wise-shipment-cost). Holding a Mongo transaction open that long
  // is exactly what made write conflicts routine instead of rare — this
  // phase now commits in milliseconds.
  let order, courierServiceDoc;
  {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();

      order = await Order.findOneAndUpdate(
        { _id: id, status: "new" },
        { $set: { status: "processing" } },
        { new: true, session }
      );
      if (!order) throw new Error("Order already processed");
      if (order.orderType !== "B2B") throw new Error("BigShip B2B supports B2B orders only");

      // Resolve which exact BigShip courier this rate-card service represents
      // — derived server-side from the courierService record rather than
      // trusted from the client, since it determines which courierId books.
      courierServiceDoc = await CourierServiceB2B.findOne({ name: courierServiceName }).select("courier weight").session(session);
      if (!courierServiceDoc?.courier) {
        throw new Error(`No BigShip courier mapping found for service "${courierServiceName}"`);
      }

      await session.commitTransaction();
      session.endSession();
    } catch (error) {
      if (session.inTransaction()) await session.abortTransaction();
      session.endSession();
      console.error("Error in BigShip B2B Shipment (lock phase):", error.message);
      return res.status(400).json({ success: false, message: error.message });
    }
  }

  // ── PHASE 2: the slow external calls — no DB transaction held here ───────
  // Nothing external has happened yet, so on any failure here it's always
  // safe to just revert the order back to "new" (plain single-document
  // update, no transaction needed).
  const revertToNew = () => Order.updateOne({ _id: id }, { $set: { status: "new" } }).catch(() => {});

  let bigshipOrderId, courierOptions, matchedCourier;
  try {
    ({ bigshipOrderId, couriers: courierOptions } = await getBigShipCourierOptions(order, "domestic_b2b"));
  } catch (err) {
    await revertToNew();
    return res.status(400).json({ success: false, message: err.response?.data?.message || err.message || "BigShip order/rate fetch failed" });
  }

  matchedCourier = courierOptions.find((c) => c.courierName === courierServiceDoc.courier);
  if (!matchedCourier) {
    await revertToNew();
    return res.status(400).json({ success: false, message: `BigShip no longer has "${courierServiceDoc.courier}" serviceable on this route.` });
  }

  // RECOMPUTE AUTHORITATIVE CHARGE — never trust client-supplied finalCharges
  // for a wallet debit. Uses the live courier options above so ODA only gets
  // charged when the route is actually remote for this courier.
  const liveServiceability = courierOptions.map((c) => ({ key: c.courierName, isODA: parseFloat(c.oda) > 0 }));
  const { working } = await getAuthoritativeB2BRate({ order, provider: "BigShip", courierServiceName, liveServiceability });
  const finalCharges = working.grand_total;
  const rateBreakup = working;

  // Wallet balance CHECK only here — no debit yet. Debiting only after
  // place-order actually succeeds (matching the B2C flow) means a
  // place-order failure never needs a compensating refund, since nothing
  // was deducted yet.
  const user = await User.findById(order.userId);
  const wallet = await Wallet.findById(user.Wallet).select("balance holdAmount creditLimit");
  const walletId = user.Wallet;
  const effectiveBalance = wallet.balance - (wallet.holdAmount || 0);
  const balance = effectiveBalance + wallet.creditLimit;
  if (balance < finalCharges) {
    await revertToNew();
    return res.status(400).json({ success: false, message: "Insufficient Wallet Balance" });
  }

  let placeResult;
  try {
    // rovType is this app's existing B2B risk-ownership field — map it onto
    // BigShip's riskTypeId (1: Third Party, 2: Owner Risk, 3: Carrier Risk).
    const riskName = order.rovType === "ROV Carrier" ? "Carrier Risk" : "Owner Risk";
    const riskTypeId = await getRiskTypeId(riskName);
    placeResult = await placeBigShipOrder(order, bigshipOrderId, matchedCourier.courierId, { riskTypeId });
  } catch (err) {
    await revertToNew();
    return res.status(400).json({ success: false, message: err.response?.data?.message || err.message || "BigShip order placement failed" });
  }

  const awb_number = String(placeResult.awb_assigned || placeResult.reference_number || "");
  if (!awb_number) {
    await revertToNew();
    return res.status(400).json({ success: false, message: "BigShip did not return an AWB number." });
  }

  // ── PHASE 3: point of no return reached — persist + debit, never touch
  // BigShip again regardless of what happens here. Short transaction, so
  // conflicts are rare — and retrying just this step is always safe.
  let persisted = false;
  for (let attempt = 1; attempt <= 3 && !persisted; attempt++) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const newBalance = wallet.balance - Number(finalCharges);
      await Promise.all([
        Order.findByIdAndUpdate(
          id,
          {
            $set: {
              status: "Booked",
              awb_number,
              // provider = real assigned carrier, partner = aggregator — same
              // convention as every other aggregator-backed provider here.
              provider: matchedCourier.courierName || "BigShip",
              partner: "BigShip",
              courierServiceName,
              totalFreightCharges: finalCharges,
              rateBreakup,
              shipmentCreatedAt: new Date(),
              "otherDetails.bigshipOrderId": bigshipOrderId,
            },
            $push: {
              tracking: {
                status: "Booked",
                Instructions: "Shipment booked via BigShip",
                StatusDateTime: new Date(Date.now() + 5.5 * 60 * 60 * 1000),
              },
            },
          },
          { session }
        ),
        Wallet.findByIdAndUpdate(walletId, { $inc: { balance: -finalCharges } }, { session }),
        WalletTransaction.create(
          [
            {
              walletId,
              channelOrderId: order.orderId,
              category: "debit",
              amount: finalCharges,
              balanceAfterTransaction: newBalance,
              description: "Freight Charges Applied",
              date: new Date(),
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
          `[BigShip B2B] CRITICAL: AWB ${awb_number} (BigShip order ${bigshipOrderId}) was placed but could not be saved after 3 attempts — needs manual reconciliation:`,
          error.message
        );
      } else {
        console.warn(`[BigShip B2B] Write conflict persisting AWB ${awb_number} on attempt ${attempt}. Retrying in ${50 * attempt}ms...`);
        await sleep(50 * attempt);
      }
    }
  }

  // Success is reported based on BigShip's own confirmation, not on whether
  // phase 3 fully persisted — the shipment is real either way.
  return res.status(200).json({
    success: true,
    message: "Shipment Created Successfully",
    orderId: order.orderId,
    awb_number,
  });
};

module.exports = {
  getBigShipServiceableCouriers,
  createBigShipCargoShipment,
};
