const cron = require("node-cron");
const Order = require("../models/newOrder.model");
const FailedNdrAction = require("../models/FailedNdrAction.model");
const { runNdrTask } = require("../utils/ndrTaskRunner");

/**
 * Consolidated NDR Job (6 AM Daily)
 * 1. Automatically triggers re-attempts for "Undelivered" shipments.
 * 2. Retries failed actions from the previous day.
 */
console.log("NDR Cron Jobs Initialized: 6 AM Consolidated Job.");

cron.schedule("0 6 * * *", async () => {

  if (process.env.NODE_ENV !== "production") {
    console.log("NDR Cron Job skipped: Not in production environment.");
    return;
  }

  console.log("Running Consolidated Daily 6 AM NDR Job...");

  // --- PART 1: Retry previously failed actions ---
  try {
    console.log("Processing failed NDR actions from the queue...");
    const failedActions = await FailedNdrAction.find({
      status: { $in: ["pending", "failed"] },
      retryCount: { $lt: 5 },
    });

    for (const action of failedActions) {
      console.log(`Retrying NDR for AWB: ${action.awb_number} (Retry #${action.retryCount + 1})`);
      const result = await runNdrTask(action.orderId, action.payload);

      if (result.success) {
        action.status = "completed";
        action.lastError = null;
      } else {
        action.status = "failed";
        action.lastError = result.message || result.error || "Unknown error";
        action.retryCount += 1;

        if (action.retryCount >= 5) {
          action.status = "failed_permanently";
          const order = await Order.findById(action.orderId);
          if (order) {
            order.ndrStatus = "Undelivered";
            order.reattempt = true;
            if (!Array.isArray(order.ndrHistory)) order.ndrHistory = [];
            const exhaustEntry = {
              action: action.action,
              actionBy: "ShipexIndia",
              remark: `Background retry exhausted (5 attempts). Final Error: ${action.lastError}`,
              source: "ShipexIndia",
              date: new Date(),
            };
            order.ndrHistory.push({ actions: [exhaustEntry] });
            await order.save();
          }
        }
      }
      action.lastAttemptAt = new Date();
      await action.save();
    }
  } catch (error) {
    console.error("Error during failed NDR actions retry:", error);
  }

  // --- PART 2: New Daily Auto Re-attempts ---
  try {
    const eligibleOrders = await Order.find({
      ndrStatus: "Undelivered",
      reattempt: true,
      status: "Undelivered",
    });

    console.log(`Found ${eligibleOrders.length} new orders for daily re-attempt.`);

    for (const order of eligibleOrders) {
      const actionDetails = {
        action: "RE-ATTEMPT",
        remarks: "Kindly Reattempt on priority basis.",
        comments: "Kindly Reattempt on priority basis.",
      };

      console.log(`Triggering daily re-attempt for AWB: ${order.awb_number}`);
      const result = await runNdrTask(order._id, actionDetails);

      // Always set reattempt to false once processed (successfully or queued)
      order.reattempt = false;
      await order.save();


      if (!result.success) {
        order.ndrStatus = "Action_Requested";
        order.status = "Action_Requested";
        if (!Array.isArray(order.ndrHistory)) order.ndrHistory = [];
        const autoEntry = {
          action: "RE-ATTEMPT",
          actionBy: "ShipexIndia",
          remark: "Kindly Reattempt on priority basis.",
          source: "ShipexIndia",
          date: new Date(),
        };
        order.ndrHistory.push({ actions: [autoEntry] });
        await order.save();

        await FailedNdrAction.create({
          orderId: order._id,
          awb_number: order.awb_number,
          action: "RE-ATTEMPT",
          payload: actionDetails,
          lastError: result.message || result.error,
          lastAttemptAt: new Date(),
          status: "failed"
        });
      }
    }
  } catch (error) {
    console.error("Error during new daily re-attempts:", error);
  }
}, {
  scheduled: true,
  timezone: "Asia/Kolkata"
});



