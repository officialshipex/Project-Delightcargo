const Order = require("../models/newOrder.model");
const Plan = require("../models/Plan.model");
const rateCards = require("../models/rateCards");
const users = require("../models/User.model");
const wallet = require("../models/wallet");
const cron = require("node-cron");
const zoneManagementController = require("../Rate/zoneManagementController");
const getZone = zoneManagementController.getZone;

// Helper sleep function for delay
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const rtoCharges = async () => {
  try {
    const gstRate = 18;
    const orders = await Order.find({
      status: "RTO Delivered",
      RTOCharges: { $exists: false },
    });

    console.log("Total RTO Orders Found:", orders.length);

    for (const item of orders) {
      try {
        console.log("Processing AWB:", item.awb_number || "No AWB");

        const result = await getZone(
          item.pickupAddress.pinCode,
          item.receiverAddress.pinCode
        );
        const currentZone = result.zone;
        // console.log("courierServiceName",item.courierServiceName);
        const plans = await Plan.findOne({ userId: item.userId });
        // console.log("plans", plans.planName);
        const ratecards = await rateCards.findOne({
          plan: plans.planName,
          courierServiceName: item.courierServiceName,
        });

        // console.log("ratecards", ratecards);

        const extraWeight =
          item.packageDetails.applicableWeight * 1000 -
          ratecards.weightPriceBasic[0].weight;
        const extraWeightCount = Math.ceil(
          extraWeight / ratecards.weightPriceAdditional[0].weight
        );

        let basicChargef = parseFloat(
          ratecards.weightPriceBasic[0][currentZone]
        );
        let charges = basicChargef;

        if (extraWeight !== 0) {
          charges +=
            parseFloat(ratecards.weightPriceAdditional[0][currentZone]) *
            extraWeightCount;
        }

        let codCharges = 0;
        if (item.paymentDetails.method === "COD") {
          codCharges = Math.max(
            ratecards.codCharge,
            item.paymentDetails.amount * (ratecards.codPercent / 100)
          );
        }

        const gstAmountForward = parseFloat(
          (charges * (gstRate / 100)).toFixed(2)
        );
        const totalChargesReverse = charges + gstAmountForward;

        const awb = item.awb_number || "";
        const codDescription = "COD Charges Received";
        const rtoDescription = "RTO Freight Charges Applied";
        const currentDate = new Date();

        const user = await users.findOne({ _id: item.userId });
        const Wallet = await wallet.findOne({ _id: user.Wallet });

        // Track live balance during updates
        let liveBalance = Wallet.balance;

        // Helper: Remove transaction and update balance
        const removeTransactionAndUpdateBalance = async (
          walletDoc,
          awb_number,
          description
        ) => {
          const existingTx = walletDoc.transactions.find(
            (tx) =>
              tx.awb_number === awb_number && tx.description === description
          );

          if (existingTx) {
            const amount = existingTx.amount;
            const isCredit = existingTx.category === "credit";
            // Remove the transaction and adjust live balance
            await wallet.updateOne(
              { _id: walletDoc._id },
              {
                $pull: {
                  transactions: {
                    awb_number,
                    description,
                  },
                },
                $inc: {
                  balance: isCredit ? -amount : amount, // Adjust balance
                },
              }
            );
            liveBalance = isCredit
              ? liveBalance - amount
              : liveBalance + amount;
          }
        };

        // ❌ Remove duplicates if exist and update balance
        await removeTransactionAndUpdateBalance(Wallet, awb, codDescription);
        await removeTransactionAndUpdateBalance(Wallet, awb, rtoDescription);

        // ✅ Update order with RTO charges
        await Order.updateOne(
          { _id: item._id },
          { $set: { RTOCharges: totalChargesReverse.toFixed(2) } }
        );

        // ✅ Add COD credit
        if (codCharges > 0) {
          liveBalance += codCharges;
          await wallet.updateOne(
            { _id: Wallet._id },
            {
              $inc: { balance: codCharges },
              $push: {
                transactions: {
                  channelOrderId: item.orderId || null,
                  category: "credit",
                  amount: codCharges,
                  balanceAfterTransaction: liveBalance,
                  date: currentDate,
                  awb_number: awb,
                  description: codDescription,
                },
              },
            }
          );
        }

        // ✅ Add RTO charge debit
        liveBalance -= totalChargesReverse;
        await wallet.updateOne(
          { _id: Wallet._id },
          {
            $inc: { balance: -totalChargesReverse },
            $push: {
              transactions: {
                channelOrderId: item.orderId || null,
                category: "debit",
                amount: totalChargesReverse,
                balanceAfterTransaction: liveBalance,
                date: currentDate,
                awb_number: awb,
                description: rtoDescription,
              },
            },
          }
        );

        // ⏱️ Wait 1 second before the next order
        await sleep(1000);
      } catch (innerErr) {
        console.error(
          "❌ Error processing order:",
          item._id,
          "AWB:",
          item.awb_number,
          innerErr
        );
      }
    }
  } catch (error) {
    console.error("❌ Error in rtoCharges main block:", error);
  }
};

const startRtoLoop = async () => {
  try {
    const now = new Date();
    const currentHour = now.getHours(); // 0 - 23

    // Run only between 7 AM and 11 PM
    if (currentHour >= 7 && currentHour <= 23) {
      console.log("⏰ Running RTO Charges at", now.toLocaleTimeString());
      await rtoCharges(); // your async function

      console.log("✅ RTO Charges completed. Next run after 2 hour...");
      setTimeout(startRtoLoop, 2 * 60 * 60 * 1000); // wait 1 hour after finish
    } else {
      console.log(
        "🌙 Outside allowed hours, will retry in 2 hour:",
        now.toLocaleTimeString()
      );
      setTimeout(startRtoLoop, 2 * 60 * 60 * 1000); // check again in 1 hour
    }
  } catch (error) {
    console.error("❌ Error in RTO loop:", error);
    setTimeout(startRtoLoop, 15 * 60 * 1000); // retry in 15 min if error
  }
};

// start the loop once
// startRtoLoop();

if(process.env.NODE_ENV ==="production"){
  startRtoLoop()
}
