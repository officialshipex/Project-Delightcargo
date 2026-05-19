const mongoose = require("mongoose");
const Order = require("../../models/newOrder.model");
const User = require("../../models/User.model");
const Wallet = require("../../models/wallet");
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
}) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        // Step 1: Atomically lock the order
        const currentOrder = await Order.findOneAndUpdate(
            { _id: id, status: "new" },
            { $set: { status: "processing" } },
            { new: true, session }
        );

        if (!currentOrder) {
            return {
                success: false,
                message: "Shipment already created or order is being processed.",
            };
        }

        // Step 2: Fetch user, zone, and warehouse ID in parallel
        const [user, zone, warehouseId] = await Promise.all([
            User.findById(currentOrder.userId).session(session),
            getZone(
                currentOrder.pickupAddress.pinCode,
                currentOrder.receiverAddress.pinCode
            ),
            createBoxdWarehouse(currentOrder.userId, currentOrder.pickupAddress)
        ]);

        if (!user) throw new Error("User not found");
        if (!user.Wallet) throw new Error("User wallet not found");

        const currentWallet = await Wallet.findById(user.Wallet).session(session);
        if (!currentWallet) throw new Error("Wallet not found");

        // Step 3: Wallet balance check
        const hold = currentWallet.holdAmount || 0;
        const effectiveBalance = currentWallet.balance - hold;
        const balance = effectiveBalance + (currentWallet.creditLimit || 0);
        if (balance < finalCharges) throw new Error("Insufficient wallet balance");

        // Step 4: Zone check
        if (!zone) throw new Error("Pincode not serviceable");

        // Step 5: Create order on BoxdLogistics portal
        let createRes;
        try {
            createRes = await createBoxdOrder(currentOrder, courierServiceName, warehouseId);
            console.log("BoxdLogistics API create response:", createRes);
        } catch (err) {
            await Order.updateOne(
                { _id: id, status: "processing" },
                { $set: { status: "new" } }
            );
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

        const boxdOrderId = createRes?.id || createRes?.order_id;
        if (!boxdOrderId) {
            await Order.updateOne(
                { _id: id, status: "processing" },
                { $set: { status: "new" } }
            );
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
            await Order.updateOne(
                { _id: id, status: "processing" },
                { $set: { status: "new" } }
            );
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

        const awb =
            shipRes?.awb_number ||
            shipRes?.tracking_number ||
            shipRes?.shipment?.awb ||
            "";

        if (!awb) {
            await Order.updateOne(
                { _id: id, status: "processing" },
                { $set: { status: "new" } }
            );
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
        currentOrder.status = "Booked";
        currentOrder.awb_number = awb;
        currentOrder.shipment_id = String(boxdOrderId);
        currentOrder.provider = "Bluedart";
        currentOrder.partner = "BoxdLogistics";
        currentOrder.shipmentCreatedAt = new Date();
        currentOrder.totalFreightCharges = parseFloat(finalCharges) || 0;
        currentOrder.courierServiceName = courierServiceName;
        currentOrder.zone = zone.zone;
        currentOrder.priceBreakup = priceBreakup;
        currentOrder.tracking.push({
            status: "Booked",
            StatusLocation: currentOrder.pickupAddress?.city || "N/A",
            StatusDateTime: new Date(Date.now() + 5.5 * 60 * 60 * 1000),
            Instructions: "Order booked successfully",
        });

        currentWallet.balance -= parseFloat(finalCharges);
        currentWallet.transactions.push({
            channelOrderId: currentOrder.orderId,
            category: "debit",
            amount: parseFloat(finalCharges),
            balanceAfterTransaction: currentWallet.balance,
            date: new Date(),
            awb_number: awb,
            description: "Freight Charges Applied",
            priceBreakup
        });

        await Promise.all([
            currentOrder.save({ session }),
            currentWallet.save({ session }),
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
        await session.abortTransaction();
        await Order.updateOne(
            { _id: id, status: "processing" },
            { $set: { status: "new" } }
        ).catch(() => { });
        session.endSession();
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
