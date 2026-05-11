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

const rtoCharges = async (specificOrderId = null) => {
  try {
    const gstRate = 18;

    const query = {
      status: "RTO Delivered",
      $or: [
        { RTOCharges: { $exists: false } },
        { RTOCharges: "0" },
        { RTOCharges: 0 },
      ],
    };

    if (specificOrderId) {
      query._id = specificOrderId;
    }

    const orders = await Order.find(query);

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
        const planData = await Plan.findOne({ userId: item.userId }).session(session);

        // ✅ Get user-specific rate card from the plan's embedded array
        const userPlan = await Plan.findOne({ userId: item.userId }).session(session);

        const embeddedRateCard = userPlan?.rateCard?.find(
          (rc) => rc.courierServiceName === item.courierServiceName
        );

        if (!embeddedRateCard) {
          console.log(`⚠️ No matching RateCard found in plan for AWB ${item.awb_number}`);
          await session.abortTransaction();
          session.endSession();
          continue;
        }

        // ✅ Use isFlatRate directly from the Plan snapshot
        const isFlatRate = embeddedRateCard.isFlatRate === true;

        // 2️⃣ Calculate charges
        const applicableWeight = item.packageDetails?.applicableWeight || 0.5;
        const chargedWeight = applicableWeight * 1000;

        let charges = 0;
        let gstAmount = 0;
        let totalChargesReverse = 0;
        let codCharges = 0;

        if (!isFlatRate) {
          const basicWeight = embeddedRateCard.weightPriceBasic[0]?.weight || 500;
          const addWeight = embeddedRateCard.weightPriceAdditional[0]?.weight || 500;
          const basicCharge = parseFloat(embeddedRateCard.weightPriceBasic[0]?.[currentZone] || 0);
          const addCharge = parseFloat(embeddedRateCard.weightPriceAdditional[0]?.[currentZone] || 0);

          if (chargedWeight <= basicWeight) {
            charges = basicCharge;
          } else {
            const extraUnits = Math.ceil((chargedWeight - basicWeight) / addWeight);
            charges = basicCharge + (addCharge * extraUnits);
          }
          gstAmount = parseFloat(((charges * 18) / 100).toFixed(2));
          totalChargesReverse = parseFloat((charges + gstAmount).toFixed(2));
        }

        if (item.paymentDetails?.method === "COD") {
          codCharges = Math.max(
            embeddedRateCard.codCharge || 0,
            ((item.paymentDetails.amount || 0) * (embeddedRateCard.codPercent || 0)) / 100
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

        // 4️⃣ Check for duplicate transactions to avoid balance mismatch
        const existingTxs = userWallet.transactions || [];
        const hasCodTx = existingTxs.some(
          (t) =>
            t.awb_number === awb &&
            t.description === codDescription &&
            t.category === "credit"
        );
        const hasRtoTx = existingTxs.some(
          (t) =>
            t.awb_number === awb &&
            t.description === rtoDescription &&
            t.category === "debit"
        );

        if (hasCodTx && hasRtoTx) {
          console.log(`ℹ️ Both COD and RTO transactions already exist for AWB ${awb}, checking if order needs update.`);
          // If transactions exist but order wasn't updated, we still proceed to Step 7
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

        // 5️⃣ Apply COD credit first (if applicable) — skip if duplicate
        if (codCharges > 0 && !hasCodTx) {
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
        } else if (hasCodTx) {
          console.log(`ℹ️ Skipping COD credit for AWB ${awb} (Duplicate)`);
        }

        // 6️⃣ Apply RTO debit (only if charges > 0 and not duplicate)
        let finalBalanceForOrder = userWallet.balance;

        if (totalChargesReverse > 0 && !hasRtoTx) {
          const updAfterDebit = await applyIncAndGet(
            userWallet._id,
            -totalChargesReverse
          );
          const balanceAfterDebit = parseFloat(
            (updAfterDebit.balance || 0).toFixed(2)
          );
          finalBalanceForOrder = balanceAfterDebit;

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
          console.log(`➖ RTO debit applied for AWB ${awb}: -${totalChargesReverse}, balanceAfter=${balanceAfterDebit}`);
        } else if (hasRtoTx) {
          console.log(`ℹ️ Skipping RTO debit for AWB ${awb} (Duplicate)`);
        } else {
          console.log(`ℹ️ Skipping RTO debit for AWB ${awb} (Flat Rate or Zero Charges)`);
        }

        // 7️⃣ Save RTO charges on order (always do this to mark as processed)
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
          `✅ Processed AWB ${awb}: credit ${codCharges}, debit ${totalChargesReverse}, final balance ${finalBalanceForOrder}`
        );
      } catch (err) {
        console.error(`Error processing AWB ${item.awb_number}:`, err);
        if (session.inTransaction()) {
          try {
            await session.abortTransaction();
          } catch (e) {
            console.error("Failed abortTransaction:", e);
          }
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

module.exports = { rtoCharges };

// Optimized Background Task: Run once a day at 1 AM
// This reduces AWS billing/database load compared to polling every 3 hours.
if (process.env.NODE_ENV === "production") {
  console.log("📅 RTO Background Task Scheduled: Once a day at 1:00 AM");
  cron.schedule("0 1 * * *", async () => {
    console.log("⏰ Running Daily RTO Charges cleanup...");
    await rtoCharges();
    console.log("✅ Daily RTO Charges completed.");
  });
}
