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
  const session = await mongoose.startSession();

  try {
    const { id, courierServiceName } = req.body;
    session.startTransaction();

    const order = await Order.findOneAndUpdate(
      { _id: id, status: "new" },
      { $set: { status: "processing" } },
      { new: true, session }
    );
    if (!order) throw new Error("Order already processed");
    if (order.orderType !== "B2B") throw new Error("BigShip B2B supports B2B orders only");

    // Resolve which exact BigShip courier this rate-card service represents —
    // derived server-side from the courierService record rather than trusted
    // from the client, since it determines which courierId gets booked.
    const courierServiceDoc = await CourierServiceB2B.findOne({
      name: courierServiceName,
    }).select("courier weight");
    if (!courierServiceDoc?.courier) {
      throw new Error(`No BigShip courier mapping found for service "${courierServiceName}"`);
    }

    /* 1.5 RECOMPUTE AUTHORITATIVE CHARGE — never trust client-supplied
       finalCharges for a wallet debit. Fetch BigShip's live courier options
       first (this also creates/reuses the draft order) so ODA only gets
       charged when the route is actually remote for this courier. */
    let bigshipOrderId, courierOptions;
    try {
      ({ bigshipOrderId, couriers: courierOptions } = await getBigShipCourierOptions(order, "domestic_b2b"));
    } catch (err) {
      throw new Error(err.message || "BigShip order/rate fetch failed");
    }

    const matchedCourier = courierOptions.find((c) => c.courierName === courierServiceDoc.courier);
    if (!matchedCourier) {
      throw new Error(`BigShip no longer has "${courierServiceDoc.courier}" serviceable on this route.`);
    }

    const liveServiceability = courierOptions.map((c) => ({
      key: c.courierName,
      isODA: parseFloat(c.oda) > 0,
    }));

    const { working } = await getAuthoritativeB2BRate({
      order,
      provider: "BigShip",
      courierServiceName,
      liveServiceability,
    });
    const finalCharges = working.grand_total;
    const rateBreakup = working;

    /* 2. WALLET CHECK */
    const user = await User.findById(order.userId).session(session);
    const wallet = await Wallet.findById(user.Wallet).select("balance holdAmount creditLimit").session(session);

    const effectiveBalance = wallet.balance - (wallet.holdAmount || 0);
    const balance = effectiveBalance + wallet.creditLimit;
    if (balance < finalCharges) throw new Error("Insufficient Wallet Balance");

    /* 3. DEDUCT WALLET (IMMEDIATE) */
    const newBalance = wallet.balance - Number(finalCharges);
    await Promise.all([
      Wallet.findByIdAndUpdate(user.Wallet, { $inc: { balance: -finalCharges } }, { session }),
      WalletTransaction.create(
        [
          {
            walletId: user.Wallet,
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

    /* 4. PLACE THE ORDER */
    const placeResult = await placeBigShipOrder(order, bigshipOrderId, matchedCourier.courierId);
    const awb_number = String(placeResult.awb_assigned || placeResult.reference_number || "");
    if (!awb_number) {
      throw new Error("BigShip did not return an AWB number.");
    }

    await Order.findByIdAndUpdate(
      id,
      {
        $set: {
          status: "Booked",
          awb_number,
          // provider = real assigned carrier, partner = aggregator — same
          // convention as every other aggregator-backed provider in this app.
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
    );

    await session.commitTransaction();
    session.endSession();

    return res.status(200).json({
      success: true,
      message: "Shipment Created Successfully",
      orderId: order.orderId,
      awb_number,
    });
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction();
    session.endSession();
    console.error(
      "Error in BigShip B2B Shipment:",
      error.response?.data ? JSON.stringify(error.response.data, null, 2) : error.message
    );
    return res.status(400).json({ success: false, message: error.message });
  }
};

module.exports = {
  getBigShipServiceableCouriers,
  createBigShipCargoShipment,
};
