const mongoose = require("mongoose");
const Order = require("../../models/newOrder.model");
const User = require("../../models/User.model");
const Wallet = require("../../models/wallet");
const WalletTransaction = require("../../models/WalletTransaction.model");
const { getZone } = require("../../Rate/zoneManagementController");
const {
    createBoxdOrder,
    shipBoxdOrder,
    createBoxdWarehouse,
} = require("../../AllCouriers/BoxdLogistics/Courier/couriers.controller");
const { assignPickupManifest } = require("../../Orders/scheduledPickup.controller");

const createBoxdLogisticsShipment = async ({
    id,
    provider,
    finalCharges,
    courierServiceName,
    courier,       // courier_id (number) from serviceability response
    priceBreakup,
    userId,
    walletId,
    walletBalance,
    walletHoldAmount,
    walletCreditLimit,
}) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    let currentOrder, zone, boxdOrderId, awb, balanceToBeDeducted;

    try {
        // Step 1: Atomically lock the order
        currentOrder = await Order.findOneAndUpdate(
            { _id: id, status: "new" },
            { $set: { status: "processing" } },
            { new: true, session }
        );

        if (!currentOrder) {
            // Must still abort/end the session — leaving it open would hold
            // this transaction's locks until MongoDB force-aborts it (60s).
            await session.abortTransaction();
            session.endSession();
            return {
                success: false,
                message: "Shipment already created or order is being processed.",
            };
        }

        // Step 2: Fetch zone and warehouse ID in parallel
        let warehouseId;
        [zone, warehouseId] = await Promise.all([
            getZone(
                currentOrder.pickupAddress.pinCode,
                currentOrder.receiverAddress.pinCode
            ),
            createBoxdWarehouse(currentOrder.userId, currentOrder.pickupAddress)
        ]);

        // Step 3: Wallet balance check
        const hold = walletHoldAmount || 0;
        const effectiveBalance = walletBalance - hold;
        const balance = effectiveBalance + (walletCreditLimit || 0);
        if (balance < finalCharges) throw new Error("Insufficient wallet balance");

        // Step 4: Zone check
        if (!zone) throw new Error("Pincode not serviceable");

        // Step 5: Create order on BoxdLogistics portal
        let createRes;
        try {
            createRes = await createBoxdOrder(currentOrder, courierServiceName, warehouseId);
            console.log("BoxdLogistics API create response:", createRes);
        } catch (err) {
            // abortTransaction() alone reverts the uncommitted "processing"
            // write — a separate non-transactional write to the same
            // document here would block on this transaction's own lock
            // until MongoDB force-aborts it (default 60s), not a real delay.
            await session.abortTransaction();
            session.endSession();
            console.error(
                "❌ BoxdLogistics create order failed:",
                err.response?.data || err.message
            );
            return {
                success: false,
                message:
                    err.response?.data?.message ||
                    "Failed to create order",
            };
        }

        boxdOrderId = createRes?.id || createRes?.order_id;
        if (!boxdOrderId) {
            // abortTransaction() alone reverts the uncommitted "processing"
            // write — a separate non-transactional write to the same
            // document here would block on this transaction's own lock
            // until MongoDB force-aborts it (default 60s), not a real delay.
            await session.abortTransaction();
            session.endSession();
            return {
                success: false,
                message:
                    createRes?.message || "BoxdLogistics did not return a valid order ID",
            };
        }

        // Step 6: Ship (assign courier)
        let shipRes;
        try {
            let courierId = parseInt(courier);
            if (!courierId) {
                const sName = courierServiceName.toLowerCase();
                if (sName.includes("flat 0.5kg") || sName.includes("flat 0.5")) {
                    courierId = 47;
                } else if (sName.includes("flat 2kg")) {
                    courierId = 7;
                } else if (sName.includes("air")) {
                    courierId = 6;
                } else if (sName.includes("surface")) {
                    courierId = 4;
                }
            }

            if (!courierId) {
                throw new Error("Courier ID is required for BoxdLogistics shipment");
            }
            shipRes = await shipBoxdOrder(boxdOrderId, courierId);
            console.log("BoxdLogistics API ship response:", shipRes);
        } catch (err) {
            // abortTransaction() alone reverts the uncommitted "processing"
            // write — a separate non-transactional write to the same
            // document here would block on this transaction's own lock
            // until MongoDB force-aborts it (default 60s), not a real delay.
            await session.abortTransaction();
            session.endSession();
            console.error(
                "❌ BoxdLogistics ship order failed:",
                err.response?.data || err.message
            );
            return {
                success: false,
                message:
                    err.response?.data?.message ||
                    "Failed to ship order",
            };
        }

        awb =
            shipRes?.awb_number ||
            shipRes?.tracking_number ||
            shipRes?.shipment?.awb ||
            "";

        if (!awb) {
            // abortTransaction() alone reverts the uncommitted "processing"
            // write — a separate non-transactional write to the same
            // document here would block on this transaction's own lock
            // until MongoDB force-aborts it (default 60s), not a real delay.
            await session.abortTransaction();
            session.endSession();
            return {
                success: false,
                message:
                    shipRes?.message ||
                    "BoxdLogistics did not return a valid AWB number",
            };
        }

        // Step 7: Update order + wallet atomically
        balanceToBeDeducted = parseFloat(finalCharges) || 0;

        await Promise.all([
            Order.findByIdAndUpdate(
                id,
                {
                    $set: {
                        status: "Booked",
                        awb_number: awb,
                        shipment_id: String(boxdOrderId),
                        provider: "Bluedart",
                        partner: "BoxdLogistics",
                        shipmentCreatedAt: new Date(),
                        totalFreightCharges: balanceToBeDeducted,
                        courierServiceName,
                        zone: zone.zone,
                        priceBreakup
                    },
                    $push: {
                        tracking: {
                            status: "Booked",
                            StatusLocation: currentOrder.pickupAddress?.city || "N/A",
                            StatusDateTime: new Date(Date.now() + 5.5 * 60 * 60 * 1000),
                            Instructions: "Order booked successfully",
                        }
                    }
                },
                { session }
            ),
            Wallet.updateOne(
                { _id: walletId },
                {
                    $inc: { balance: -balanceToBeDeducted },
                },
                { session }
            ),
            WalletTransaction.create(
                [
                    {
                        walletId: walletId,
                        channelOrderId: currentOrder.orderId,
                        category: "debit",
                        amount: balanceToBeDeducted,
                        balanceAfterTransaction: walletBalance - balanceToBeDeducted,
                        date: new Date(),
                        awb_number: awb,
                        description: "Freight Charges Applied",
                        priceBreakup
                    }
                ],
                { session }
            )
        ]);

        await session.commitTransaction();
        session.endSession();

        // ── Auto-assign pickup manifest (non-blocking) ──
        Order.findById(currentOrder._id)
            .then((freshOrder) => {
                if (freshOrder) assignPickupManifest(freshOrder);
            })
            .catch((pErr) => {
                console.error("[Pickup] assignPickupManifest failed:", pErr.message);
            });

        return {
            success: true,
            message: "Shipment Created Successfully",
            awb_number: awb,
        };
    } catch (error) {
        if (session.inTransaction()) await session.abortTransaction();
        session.endSession();

        if (awb) {
            // BoxdLogistics already confirmed a real, irreversible shipment
            // before this failure hit (e.g. a write conflict during the
            // commit) — recover by persisting directly instead of resetting
            // the order to "new" and losing the AWB.
            console.error(`[BoxdLogistics] AWB ${awb} was already placed when this failed (${error.message}). Recovering instead of reporting failure.`);
            try {
                await Promise.all([
                    Order.findByIdAndUpdate(id, {
                        $set: {
                            status: "Booked",
                            awb_number: awb,
                            shipment_id: String(boxdOrderId),
                            provider: "Bluedart",
                            partner: "BoxdLogistics",
                            shipmentCreatedAt: new Date(),
                            totalFreightCharges: balanceToBeDeducted,
                            courierServiceName,
                            zone: zone?.zone,
                            priceBreakup,
                        },
                        $push: {
                            tracking: {
                                status: "Booked",
                                StatusLocation: currentOrder?.pickupAddress?.city || "N/A",
                                StatusDateTime: new Date(Date.now() + 5.5 * 60 * 60 * 1000),
                                Instructions: "Order booked successfully (recovered after a DB write conflict)",
                            }
                        }
                    }),
                    Wallet.updateOne({ _id: walletId }, { $inc: { balance: -balanceToBeDeducted } }),
                    WalletTransaction.create([
                        {
                            walletId: walletId,
                            channelOrderId: currentOrder?.orderId,
                            category: "debit",
                            amount: balanceToBeDeducted,
                            balanceAfterTransaction: walletBalance - balanceToBeDeducted,
                            date: new Date(),
                            awb_number: awb,
                            description: "Freight Charges Applied",
                            priceBreakup,
                        },
                    ]),
                ]);
            } catch (saveErr) {
                console.error(`[BoxdLogistics] CRITICAL: could not save recovered AWB ${awb} for order ${id} — needs manual reconciliation:`, saveErr.message);
            }
            return {
                success: true,
                message: "Shipment Created Successfully",
                awb_number: awb,
            };
        }

        await Order.updateOne(
            { _id: id, status: "processing" },
            { $set: { status: "new" } }
        ).catch(() => { });
        console.error(
            "❌ BoxdLogistics API shipment error:",
            error?.response?.data || error.message
        );
        return {
            success: false,
            message:
                error?.response?.data?.message ||
                error.message ||
                "Failed to create shipment",
        };
    }
};

module.exports = createBoxdLogisticsShipment;
