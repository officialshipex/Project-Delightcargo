const user = require("../../models/User.model");
const Wallet = require("../../models/wallet");
const Order = require("../../models/newOrder.model");
const {
  cancelOrderDelhivery,
} = require("../../AllCouriers/Delhivery/Courier/couriers.controller");
const {
  cancelOrderDTDC,
} = require("../../AllCouriers/DTDC/Courier/couriers.controller");
const {
  cancelSmartshipOrder,
} = require("../../AllCouriers/SmartShip/Couriers/couriers.controller");
const {
  cancelShipment,
} = require("../../AllCouriers/Amazon/Courier/couriers.controller");

// Assuming other cancel functions are imported similarly

const mongoose = require("mongoose");

const cancelOrdersAtBooked = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { awb_number } = req.params;
    if (!awb_number) {
      await session.abortTransaction();
      return res
        .status(400)
        .json({ error: "AWB number is required in params" });
    }

    // 🔒 Find and lock order in transaction
    const currentOrder = await Order.findOne({ awb_number })
      .session(session)
      .exec();
    if (!currentOrder) {
      await session.abortTransaction();
      return res
        .status(404)
        .json({ error: `Order with AWB number ${awb_number} not found.` });
    }

    // 🚫 Prevent duplicate cancellations
    if (["Cancelled", "new"].includes(currentOrder.status)) {
      await session.abortTransaction();
      return res.status(400).json({ error: "Order is already cancelled" });
    }

    if (
      currentOrder.status !== "Ready To Ship" &&
      currentOrder.status !== "Booked" &&
      currentOrder.status !== "Not Picked"
    ) {
      await session.abortTransaction();
      return res
        .status(400)
        .json({ error: "Order is not ready to be cancelled" });
    }

    // 🧍 Find user & wallet (inside same session)
    const userDoc = await user.findById(currentOrder.userId).session(session);
    if (!userDoc) {
      await session.abortTransaction();
      return res
        .status(404)
        .json({ error: "User linked with order not found" });
    }

    const currentWallet = await Wallet.findById(userDoc.Wallet).session(
      session
    );
    if (!currentWallet) {
      await session.abortTransaction();
      return res
        .status(404)
        .json({ error: "Wallet linked with user not found" });
    }
    let provider;
    if (currentOrder.partner === "ZipyPost") {
      provider = "ZipyPost";
    } else {
      provider = currentOrder.provider;
    }

    // 🚚 Call cancellation API based on provider
    let result;
    switch (provider) {
      case "Xpressbees":
        result = await cancelShipmentXpressBees(currentOrder.awb_number);
        break;
      case "Shiprocket":
        result = await cancelOrder(currentOrder.awb_number);
        break;
      case "Delhivery":
        result = await cancelOrderDelhivery(currentOrder.awb_number);
        break;
      case "Dtdc":
        result = await cancelOrderDTDC(currentOrder.awb_number);
        break;
      case "Amazon Shipping":
        result = await cancelShipment(currentOrder.shipment_id);
        break;
      case "Smartship":
        result = await cancelSmartshipOrder(currentOrder.orderId);
        break;
      case "Shree Maruti":
        result = await cancelOrderShreemaruti(currentOrder.orderId);
        break;
      case "ZipyPost":
        result = await cancelOrderZippyPost(currentOrder.awb_number);
        break;
      default:
        await session.abortTransaction();
        return res.status(400).json({ error: "Unsupported courier provider" });
    }

    if (result?.error || result.success === false) {
      await session.abortTransaction();
      return res
        .status(400)
        .json({ error: result.error || "Failed to cancel order" });
    }

    // 🧾 Update order status + tracking atomically
    currentOrder.status = "new"; // or "Cancelled" if that's your flow
    currentOrder.tracking.push({
      status: "Cancelled",
      StatusLocation: "",
      Instructions: "Cancelled order by user",
      StatusDateTime: new Date(),
    });

    await currentOrder.save({ session });

    // 💰 Refund logic
    const balanceToBeAdded =
      currentOrder.totalFreightCharges === "N/A"
        ? 0
        : parseInt(currentOrder.totalFreightCharges);

    if (balanceToBeAdded > 0) {
      // Prevent double refund if another cancellation request already processed
      const alreadyRefunded = currentWallet.transactions.some(
        (t) =>
          t.awb_number === currentOrder.awb_number &&
          t.category === "credit" &&
          t.description === "Freight Charges Received"
      );

      if (!alreadyRefunded) {
        const newBalance = currentWallet.balance + balanceToBeAdded;

        await Wallet.findOneAndUpdate(
          { _id: currentWallet._id },
          {
            $inc: { balance: balanceToBeAdded },
            $push: {
              transactions: {
                channelOrderId: currentOrder.orderId || null,
                category: "credit",
                amount: balanceToBeAdded,
                balanceAfterTransaction: newBalance,
                date: new Date(),
                awb_number: currentOrder.awb_number,
                description: "Freight Charges Received",
              },
            },
          },
          { session }
        );
      } else {
        console.log(`⚠️ Refund already processed for ${awb_number}`);
      }
    }

    // ✅ Commit the transaction (everything succeeded)
    await session.commitTransaction();
    session.endSession();

    return res
      .status(200)
      .json({ success: true, message: "Order cancelled successfully" });
  } catch (error) {
    console.error("❌ Error cancelling order:", error);
    await session.abortTransaction();
    session.endSession();
    return res.status(500).json({
      error: "An internal error occurred while cancelling the order.",
      details: error.message,
    });
  }
};

module.exports = cancelOrdersAtBooked;
