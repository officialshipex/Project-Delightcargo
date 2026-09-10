const Order = require("../../../models/newOrder.model");
const Wallet = require("../../../models/wallet");
const WalletTransaction = require("../../../models/WalletTransaction.model");
const CourierService = require("../../../models/CourierService.Schema");
const { getZone } = require("../../../Rate/zoneManagementController");
const { assignPickupManifest } = require("../../../Orders/scheduledPickup.controller");
const {
  getBigShipCourierOptions,
  placeBigShipOrder,
  getRiskTypeId,
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
      return { status: 400, error: err.response?.data?.message || err.message || "BigShip order/rate fetch failed" };
    }

    const matchedCourier = courierOptions.find((c) => c.courierName === courierServiceDoc.courier);
    if (!matchedCourier) {
      return { status: 400, error: `BigShip no longer has "${courierServiceDoc.courier}" serviceable on this route.` };
    }

    let placeResult;
    try {
      // B2C has no rovType concept — defaults to Owner Risk, same as the
      // single-order flow. This was previously omitted entirely, which (after
      // placeBigShipOrder was fixed to always require riskTypeId) meant every
      // bulk BigShip booking sent the literal string "undefined" and failed.
      const riskTypeId = await getRiskTypeId("Owner Risk");
      placeResult = await placeBigShipOrder(currentOrder, bigshipOrderId, matchedCourier.courierId, { riskTypeId });
    } catch (err) {
      return { status: 400, error: err.response?.data?.message || err.message || "BigShip order placement failed" };
    }

    const awb_number = String(placeResult.awb_assigned || placeResult.reference_number || "");
    if (!awb_number) return { status: 400, error: "BigShip did not return an AWB number." };

    // Point of no return: BigShip already placed a real, irreversible
    // shipment above. From here, retry the persistence a few times on
    // failure, but never touch BigShip again regardless of the outcome —
    // same reasoning as the single-order flow's write-conflict fix.
    let persisted = false;
    for (let attempt = 1; attempt <= 3 && !persisted; attempt++) {
      try {
        await Order.findByIdAndUpdate(orderId, {
          $set: {
            status: "Booked",
            awb_number,
            provider: matchedCourier.courierName || "BigShip",
            partner: "BigShip",
            totalFreightCharges: charges,
            courierServiceName: serviceDetails.name,
            zone: zone.zone,
            estimatedDeliveryDate: estimatedDeliveryDate || null,
            priceBreakup,
            shipmentCreatedAt: new Date(),
            "otherDetails.bigshipOrderId": bigshipOrderId,
          },
          $push: {
            tracking: {
              status: "Booked",
              StatusLocation: currentOrder.pickupAddress.city || "N/A",
              StatusDateTime: new Date(Date.now() + 5.5 * 60 * 60 * 1000),
              Instructions: "Order booked successfully",
            },
          },
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
        persisted = true;
      } catch (saveErr) {
        if (attempt === 3) {
          console.error(
            `[BigShip Bulk] CRITICAL: AWB ${awb_number} (BigShip order ${bigshipOrderId}, order ${orderId}) was placed but could not be saved after 3 attempts — needs manual reconciliation:`,
            saveErr.message
          );
        } else {
          await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
        }
      }
    }

    process.nextTick(async () => {
      try {
        const fresh = await Order.findById(orderId);
        if (fresh) await assignPickupManifest(fresh);
      } catch (e) {}
    });

    // Success is reported based on BigShip's own confirmation, not on
    // whether persistence fully succeeded — the shipment is real either way.
    return { status: 201, message: "Shipment Created Successfully", waybill: awb_number, orderId: currentOrder.orderId };
  } catch (error) {
    console.error("BigShip Bulk Shipment Error:", error.response?.data || error.message);
    return { status: 500, error: "Internal Server Error", message: error.response?.data?.message || error.message };
  }
};

module.exports = { createShipmentFunctionBigShip };
