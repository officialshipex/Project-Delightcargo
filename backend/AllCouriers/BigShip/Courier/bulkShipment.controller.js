const Order = require("../../../models/newOrder.model");
const Wallet = require("../../../models/wallet");
const WalletTransaction = require("../../../models/WalletTransaction.model");
const CourierService = require("../../../models/CourierService.Schema");
const { getZone } = require("../../../Rate/zoneManagementController");
const { assignPickupManifest } = require("../../../Orders/scheduledPickup.controller");
const {
  getBigShipCourierOptions,
  placeBigShipOrder,
} = require("./couriers.controller");

// Bulk booking entry point — matches every other provider's bulk signature
// exactly (see AllCouriers/ShipRocket/Courier/bulkShipment.controller.js for
// the reference shape), called from Orders/newBulkOrders.controller.js's
// callProviderWithRetry. Unlike the single-order flow (where the frontend
// shows live BigShip options and the user picks one), bulk orders auto-select
// a courier via the matched rate card — courierDetails only carries
// {provider, name}, so the exact BigShip courierId has to be resolved here
// the same way the B2B bulk-equivalent path does: via the CourierService
// record's `courier` field matched against BigShip's live courier list.
const createShipmentFunctionBigShip = async (
  serviceDetails,
  orderId,
  wh,
  walletId,
  finalCharges,
  priceBreakup,
  estimatedDeliveryDate = null
) => {
  try {
    const currentOrder = await Order.findById(orderId);
    if (!currentOrder) return { status: 404, error: "Order not found" };

    const zone = await getZone(currentOrder.pickupAddress.pinCode, currentOrder.receiverAddress.pinCode);
    if (!zone) return { status: 400, error: "Pincode not serviceable" };

    const currentWallet = await Wallet.findById(walletId).select("balance holdAmount creditLimit");
    if (!currentWallet) return { status: 404, error: "Wallet not found" };

    const effectiveBalance = currentWallet.balance - (currentWallet.holdAmount || 0) + (currentWallet.creditLimit || 0);
    const charges = parseFloat(finalCharges) || 0;
    if (effectiveBalance < charges) return { status: 400, error: "Insufficient Wallet Balance" };

    const courierServiceDoc = await CourierService.findOne({
      name: serviceDetails.name,
      provider: "BigShip",
    }).select("courier");
    if (!courierServiceDoc?.courier) {
      return { status: 400, error: `No BigShip courier mapping found for service "${serviceDetails.name}"` };
    }

    let bigshipOrderId, courierOptions;
    try {
      ({ bigshipOrderId, couriers: courierOptions } = await getBigShipCourierOptions(currentOrder, "domestic_b2c"));
    } catch (err) {
      return { status: 400, error: err.message || "BigShip order/rate fetch failed" };
    }

    const matchedCourier = courierOptions.find((c) => c.courierName === courierServiceDoc.courier);
    if (!matchedCourier) {
      return { status: 400, error: `BigShip no longer has "${courierServiceDoc.courier}" serviceable on this route.` };
    }

    let placeResult;
    try {
      placeResult = await placeBigShipOrder(currentOrder, bigshipOrderId, matchedCourier.courierId);
    } catch (err) {
      return { status: 400, error: err.response?.data?.message || err.message || "BigShip order placement failed" };
    }

    const awb_number = String(placeResult.awb_assigned || placeResult.reference_number || "");
    if (!awb_number) return { status: 400, error: "BigShip did not return an AWB number." };

    currentOrder.status = "Booked";
    currentOrder.awb_number = awb_number;
    currentOrder.provider = matchedCourier.courierName || "BigShip";
    currentOrder.partner = "BigShip";
    currentOrder.totalFreightCharges = charges;
    currentOrder.courierServiceName = serviceDetails.name;
    currentOrder.zone = zone.zone;
    currentOrder.estimatedDeliveryDate = estimatedDeliveryDate || null;
    currentOrder.priceBreakup = priceBreakup;
    currentOrder.shipmentCreatedAt = new Date();
    if (!currentOrder.otherDetails) currentOrder.otherDetails = {};
    currentOrder.otherDetails.bigshipOrderId = bigshipOrderId;
    currentOrder.tracking.push({
      status: "Booked",
      StatusLocation: currentOrder.pickupAddress.city || "N/A",
      StatusDateTime: new Date(Date.now() + 5.5 * 60 * 60 * 1000),
      Instructions: "Order booked successfully",
    });

    await currentOrder.save();
    process.nextTick(async () => {
      try { await assignPickupManifest(currentOrder); } catch (e) {}
    });

    const updatedWallet = await Wallet.findOneAndUpdate(
      { _id: walletId },
      { $inc: { balance: -charges } },
      { new: true }
    );

    if (updatedWallet) {
      await WalletTransaction.create({
        walletId: updatedWallet._id,
        channelOrderId: currentOrder.orderId,
        category: "debit",
        amount: charges,
        balanceAfterTransaction: updatedWallet.balance,
        date: new Date(),
        awb_number,
        description: "Freight Charges Applied",
        priceBreakup,
      });
    }

    return { status: 201, message: "Shipment Created Successfully", waybill: awb_number, orderId: currentOrder.orderId };
  } catch (error) {
    console.error("BigShip Bulk Shipment Error:", error.response?.data || error.message);
    return { status: 500, error: "Internal Server Error", message: error.response?.data?.message || error.message };
  }
};

module.exports = { createShipmentFunctionBigShip };
