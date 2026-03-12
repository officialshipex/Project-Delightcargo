const Order = require("../models/newOrder.model");
const Plan = require("../models/Plan.model");
const rateCards = require("../models/rateCards");
const users = require("../models/User.model");
const wallet = require("../models/wallet");
const cron = require("node-cron");
const zoneManagementController = require("../Rate/zoneManagementController");
const getZone = zoneManagementController.getZone;
const mongoose = require("mongoose");
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
      const session = await mongoose.startSession();
      session.startTransaction();

      try {
        console.log(`🚚 Processing AWB: ${item.awb_number}`);

        // 1️⃣ Zone + Plan + Rate Card
        const zoneRes = await getZone(
          item.pickupAddress.pinCode,
          item.receiverAddress.pinCode
        );
        const currentZone = zoneRes.zone;
        const planData = await Plan.findOne({ userId: item.userId }).session(
          session
        );
        const rateCard = await rateCards
          .findOne({
            plan: planData?.planName,
            courierServiceName: item.courierServiceName,
          })
          .session(session);

        if (!rateCard) {
          console.warn(
            `No rate card for courier ${item.courierServiceName}, skipping AWB ${item.awb_number}`
          );
          await session.abortTransaction();
          session.endSession();
          continue;
        }

        // 2️⃣ Calculate charges
        const extraWeight =
          item.packageDetails.applicableWeight * 1000 -
          rateCard.weightPriceBasic[0].weight;
        const extraWeightCount = Math.max(
          0,
          Math.ceil(extraWeight / rateCard.weightPriceAdditional[0].weight)
        );

        let baseCharge =
          parseFloat(rateCard.weightPriceBasic[0][currentZone]) || 0;
        let charges = baseCharge;
        if (extraWeight > 0) {
          charges +=
            (parseFloat(rateCard.weightPriceAdditional[0][currentZone]) || 0) *
            extraWeightCount;
        }

        const gstAmount = parseFloat(((charges * gstRate) / 100).toFixed(2));
        const totalChargesReverse = parseFloat(
          (charges + gstAmount).toFixed(2)
        );

        let codCharges = 0;
        if (item.paymentDetails?.method === "COD") {
          codCharges = Math.max(
            rateCard.codCharge || 0,
            ((item.paymentDetails.amount || 0) * (rateCard.codPercent || 0)) /
              100
          );
          codCharges = parseFloat(codCharges.toFixed(2));
        }

        // 3️⃣ Fetch user & wallet
        const user = await users.findById(item.userId).session(session);
        if (!user) {
          console.warn(`User not found for order ${item._id}`);
          await session.abortTransaction();
          session.endSession();
          continue;
        }

        // get wallet (with transactions)
        const userWallet = await wallet.findById(user.Wallet).session(session);
        if (!userWallet) {
          console.warn(`Wallet not found for user ${user._id}`);
          await session.abortTransaction();
          session.endSession();
          continue;
        }

        const awb = item.awb_number || "";
        const now = new Date();
        const codDate = new Date(now.getTime()); // original
        const rtoDate = new Date(now.getTime() + 1000); // +1 second ensures correct sort order
        const codDescription = "COD Charges Received";
        const rtoDescription = "RTO Freight Charges Applied";

        // 4️⃣ If there are existing transactions for this AWB, compute net effect and revert it BEFORE removing them
        const existingTxs = (userWallet.transactions || []).filter(
          (t) =>
            t.awb_number === awb &&
            (t.description === codDescription ||
              t.description === rtoDescription)
        );

        if (existingTxs.length > 0) {
          // compute net amount (credit positive, debit negative)
          let netAmount = 0;
          for (const t of existingTxs) {
            const amt = parseFloat(t.amount) || 0;
            if (String(t.category).toLowerCase() === "credit") netAmount += amt;
            else netAmount -= amt; // debit
          }

          // If there is a net effect, revert it from wallet.balance
          if (Math.abs(netAmount) > 0.0001) {
            // revert by applying -(netAmount)
            const revertInc = -netAmount;
            const reverted = await wallet
              .findOneAndUpdate(
                { _id: userWallet._id },
                { $inc: { balance: revertInc } },
                { new: true, session }
              )
              .lean();

            console.log(
              `🔁 Reverted existing TXs for AWB ${awb}: netAmount=${netAmount}, applied revertInc=${revertInc}, newBalance=${reverted.balance}`
            );
          } else {
            console.log(
              `🔁 Found existing transactions for AWB ${awb} but netAmount is 0 — removing records without balance change.`
            );
          }

          // Now remove the old transactions (we already applied balance revert)
          await wallet.updateOne(
            { _id: userWallet._id },
            {
              $pull: {
                transactions: {
                  awb_number: awb,
                  description: { $in: [codDescription, rtoDescription] },
                },
              },
            },
            { session }
          );

          // Important: refresh userWallet variable to reflect reverted balance for later ops
          // (we'll re-fetch before applying new increments)
        }

        // Helper: atomically apply an increment and return new wallet doc
        const applyIncAndGet = async (walletId, incValue) => {
          const updated = await wallet
            .findOneAndUpdate(
              { _id: walletId },
              { $inc: { balance: incValue } },
              { new: true, session }
            )
            .lean();
          return updated;
        };

        // re-fetch wallet to ensure we have latest balance (after possible revert)
        const walletBeforeOps = await wallet
          .findById(userWallet._id)
          .session(session);

        // 5️⃣ Apply COD credit first (if applicable) — atomic increment then push transaction using returned balance
        if (codCharges > 0) {
          const upd = await applyIncAndGet(userWallet._id, codCharges);
          const balanceAfter = parseFloat((upd.balance || 0).toFixed(2));

          await wallet.updateOne(
            { _id: userWallet._id },
            {
              $push: {
                transactions: {
                  channelOrderId: item.orderId || null,
                  category: "credit",
                  amount: codCharges,
                  balanceAfterTransaction: balanceAfter,
                  date: codDate,
                  awb_number: awb,
                  description: codDescription,
                },
              },
            },
            { session }
          );

          console.log(
            `➕ COD applied for AWB ${awb}: +${codCharges}, balanceAfter=${balanceAfter}`
          );
        }

        // 6️⃣ Apply RTO debit (atomic decrement and then push tx with returned balance)
        const updAfterDebit = await applyIncAndGet(
          userWallet._id,
          -totalChargesReverse
        );
        const balanceAfterDebit = parseFloat(
          (updAfterDebit.balance || 0).toFixed(2)
        );

        await wallet.updateOne(
          { _id: userWallet._id },
          {
            $push: {
              transactions: {
                channelOrderId: item.orderId || null,
                category: "debit",
                amount: totalChargesReverse,
                balanceAfterTransaction: balanceAfterDebit,
                date: rtoDate,
                awb_number: awb,
                description: rtoDescription,
                priceBreakup: {
                  freight: charges,
                  gst: gstAmount,
                },
              },
            },
          },
          { session }
        );

        // 7️⃣ Save RTO charges on order
        await Order.updateOne(
          { _id: item._id },
          {
            $set: {
              RTOCharges: totalChargesReverse,
              "priceBreakup.rto.freight": charges,
              "priceBreakup.rto.gst": gstAmount,
            },
          },
          { session }
        );

        // 8️⃣ commit
        await session.commitTransaction();
        console.log(
          `✅ Processed AWB ${awb}: credit ${codCharges}, debit ${totalChargesReverse}, final balance ${balanceAfterDebit}`
        );
      } catch (err) {
        console.error(`Error processing AWB ${item.awb_number}:`, err);
        try {
          await session.abortTransaction();
        } catch (e) {
          console.error("Failed abortTransaction:", e);
        }
      } finally {
        session.endSession();
      }

      // small delay to reduce DB contention
      await sleep(200);
    }
  } catch (err) {
    console.error("rtoCharges main error:", err);
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

      console.log("✅ RTO Charges completed. Next run after 3 hour...");
      setTimeout(startRtoLoop, 3 * 60 * 60 * 1000); // wait 3 hour after finish
    } else {
      console.log(
        "🌙 Outside allowed hours, will retry in 3 hour:",
        now.toLocaleTimeString()
      );
      setTimeout(startRtoLoop, 3 * 60 * 60 * 1000); // check again in 3 hour
    }
  } catch (error) {
    console.error("❌ Error in RTO loop:", error);
    setTimeout(startRtoLoop, 3 * 60 * 60 * 1000); // retry in 15 min if error
  }
};

// start the loop once
// startRtoLoop();

if (process.env.NODE_ENV === "production") {
  startRtoLoop();
}
