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
const {
  cancelOrderZipypost,
} = require("../../AllCouriers/Zipypost/Couriers/couriers.controller");
// Assuming other cancel functions are imported similarly

const mongoose = require("mongoose");
const {
  cancelOrderShreeMaruti,
} = require("../../AllCouriers/ShreeMaruti/Couriers/couriers.controller");

const cancelOrdersAtBooked = async (req, res) => {
  const MAX_RETRIES = 1;
  let attempt = 0;

  while (attempt < MAX_RETRIES) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      attempt++;
      const { awb_number } = req.params;
      if (!awb_number) {
        throw new Error("AWB number is required in params");
      }

      const currentOrder = await Order.findOne({ awb_number }).session(session);
      if (!currentOrder)
        throw new Error(`Order with AWB number ${awb_number} not found`);

      if (["Cancelled", "new"].includes(currentOrder.status)) {
        throw new Error("Order is already cancelled");
      }

      if (
        !["Ready To Ship", "Booked", "Not Picked"].includes(currentOrder.status)
      ) {
        throw new Error("Order is not ready to be cancelled");
      }

      const userDoc = await user.findById(currentOrder.userId).session(session);
      if (!userDoc) throw new Error("User linked with order not found");

      const currentWallet = await Wallet.findById(userDoc.Wallet).session(
        session
      );
      if (!currentWallet) throw new Error("Wallet linked with user not found");
      // console.log("currentOrder", currentOrder);
      let provider;

      if (
        currentOrder.partner === "ZipyPost" &&
        currentOrder.provider === "Bluedart"
      ) {
        provider = "ZipyPost";
      } else {
        provider = currentOrder.provider;
      }
      // console.log("provider", provider);
      let result;
      switch (provider) {
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
          result = await cancelOrderShreeMaruti(currentOrder.orderId);
          break;
        case "ZipyPost":
          result = await cancelOrderZipypost(currentOrder.awb_number);
          break;
        default:
          throw new Error("Unsupported courier provider");
      }

      if (result?.error || result.success === false) {
        return res.status(400).json({
          success: false,
          message:
            result.message || "Failed to cancel order with courier provider",
        });
      }

      // Update order
      currentOrder.status = "new";
      currentOrder.tracking.push({
        status: "Cancelled",
        StatusLocation: "",
        Instructions: "Cancelled order by user",
        StatusDateTime: new Date(),
      });
      await currentOrder.save({ session });

      // Refund if needed
      const balanceToBeAdded =
        currentOrder.totalFreightCharges === "N/A"
          ? 0
          : parseInt(currentOrder.totalFreightCharges);

      if (balanceToBeAdded > 0) {
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
        }
      }

      await session.commitTransaction();
      session.endSession();

      return res.status(200).json({
        success: true,
        message: "Order cancelled successfully",
      });
    } catch (error) {
      await session.abortTransaction();
      session.endSession();

      if (
        error.errorLabels?.includes("TransientTransactionError") &&
        attempt < MAX_RETRIES
      ) {
        console.warn(`⚠️ Transient error on attempt ${attempt}, retrying...`);
        continue;
      }

      console.error("❌ Error cancelling order:", error);
      return res.status(500).json({
        error: error.message || "Internal server error",
      });
    }
  }
};

module.exports = cancelOrdersAtBooked;
