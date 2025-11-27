const mongoose = require("mongoose");
const cron = require("node-cron");
const CodPlan = require("./codPan.model");
const codRemittance = require("./codRemittance.model");
const Order = require("../models/newOrder.model");
const adminCodRemittance = require("./adminCodRemittance.model");
const users = require("../models/User.model");
const Wallet = require("../models/wallet");
const afterPlan = require("./afterPlan.model");
const fs = require("fs");
const csvParser = require("csv-parser");
const User = require("../models/User.model.js");
const ExcelJS = require("exceljs");
const path = require("path");
const xlsx = require("xlsx");
const File = require("../model/bulkOrderFiles.model.js");
const AllocateRole = require("../models/allocateRoleSchema");
const bankAccount = require("../models/BankAccount.model.js");

// const { date } = require("joi");
const CourierCodRemittance = require("./CourierCodRemittance.js");
const CodRemittanceOrdersModel = require("./CodRemittanceOrder.model.js");
const SameDateDelivered = require("./samedateDelivery.model.js");
const BankAccountDetails = require("../models/BankAccount.model.js");
const codPlanUpdate = async (req, res) => {
  try {
    const { id } = req.query;
    const userID = id || req.user?._id; // Ensure req.user exists
    const { planName, codAmount } = req.body;

    // console.log("Request Body:", req.body); // Debugging log

    // Validate user authentication
    if (!userID) {
      return res.status(401).json({
        success: false,
        error: "User not authenticated",
      });
    }

    // Validate request body
    if (!planName || !codAmount) {
      return res.status(400).json({
        success: false,
        error: "Plan name and COD amount are required",
      });
    }

    // Find existing COD Plan for the user
    let codPlan = await CodPlan.findOne({ user: userID });

    if (codPlan) {
      // Update existing COD Plan
      codPlan.planName = planName;
      codPlan.planCharges = codAmount;
      await codPlan.save();

      return res.status(200).json({
        success: true,
        message: "COD Plan updated successfully",
        codPlan,
      });
    } else {
      // Create new COD Plan
      codPlan = new CodPlan({
        user: userID,
        planName,
        planCharges: codAmount,
      });
      await codPlan.save();

      return res.status(201).json({
        success: true,
        message: "New COD Plan created successfully",
        codPlan,
      });
    }
  } catch (error) {
    console.error("Error updating COD Plan:", error); // Log for debugging

    return res.status(500).json({
      success: false,
      message: "An error occurred while updating the COD Plan",
      error: error.message,
    });
  }
};

const codToBeRemitteds = async () => {
  try {
    const deliveredCodOrders = await Order.aggregate([
      {
        $match: {
          status: "Delivered",
          "paymentDetails.method": "COD",
        },
      },
    ]);

    for (const order of deliveredCodOrders) {
      const latestTracking = order.tracking?.[order.tracking.length - 1];
      const deliveryDate = latestTracking?.StatusDateTime;

      if (!deliveryDate) {
        console.log(`⚠️ Skipping order ${order._id} - No delivery date`);
        continue;
      }

      const formattedDate = new Date(deliveryDate).toISOString().split("T")[0];
      const startOfDay = new Date(`${formattedDate}T00:00:00.000Z`);
      const endOfDay = new Date(`${formattedDate}T23:59:59.999Z`);

      const codAmount = order.paymentDetails.amount || 0;
      const customOrderId = order.orderId || "";

      // 🔍 Find SameDateDelivered for user and deliveryDate
      let sameDateEntry = await SameDateDelivered.findOne({
        userId: order.userId,
        deliveryDate: { $gte: startOfDay, $lte: endOfDay },
      });

      if (sameDateEntry) {
        // ✅ Check if order already exists
        const isDuplicate = sameDateEntry.orderDetails.some(
          (id) => Number(id.customOrderId) === order.orderId
        );

        if (!isDuplicate) {
          // ✅ Add to existing entry
          sameDateEntry.orderDetails.push({
            orderId: order._id,
            codAmount,
            customOrderId,
          });
          sameDateEntry.orderIds.push(order._id);
          sameDateEntry.totalCod += codAmount;
          await sameDateEntry.save();

          // ✅ Update or create remittance
          let remittance = await codRemittance.findOne({
            userId: order.userId,
          });
          if (!remittance) {
            remittance = new codRemittance({
              userId: order.userId,
              CODToBeRemitted: codAmount,
              rechargeAmount: 0,
            });
          } else {
            remittance.CODToBeRemitted += codAmount;
          }
          await remittance.save();
        }
      } else {
        // ✅ Create new SameDateDelivered entry
        await SameDateDelivered.create({
          userId: order.userId,
          deliveryDate: new Date(deliveryDate),
          orderDetails: [
            {
              orderId: order._id,
              codAmount,
              customOrderId,
            },
          ],
          orderIds: [order._id],
          totalCod: codAmount,
          status: "Pending",
        });

        // ✅ Create or update remittance
        let remittance = await codRemittance.findOne({ userId: order.userId });
        if (!remittance) {
          remittance = new codRemittance({
            userId: order.userId,
            CODToBeRemitted: codAmount,
            rechargeAmount: 0,
          });
        } else {
          remittance.CODToBeRemitted += codAmount;
        }
        await remittance.save();
      }
    }
  } catch (error) {
    console.error("❌ Error in COD to be remitted:", error);
  }
};
if (process.env.NODE_ENV === "production") {
  cron.schedule("1 1 * * *", () => {
    console.log(
      "⏰ Running scheduled task at 1:01 AM (production): Fetching orders..."
    );
    codToBeRemitteds();
  });
} else {
  console.log("⚙️ Cron job not started (development mode)");
}
// codToBeRemitteds();

const remittanceScheduleData = async () => {
  try {
    const existingSameDateDelivered = await SameDateDelivered.find({
      status: "Pending",
    });

    console.log(
      `Found ${existingSameDateDelivered.length} pending SameDateDelivered entries.`
    );

    const today = new Date();
    const isNotSunday = today.getDay() !== 0;
    const isTodayMWF = [1, 3, 5].includes(today.getDay());
    const isTodayTF = [2, 5].includes(today.getDay());

    for (const remittance of existingSameDateDelivered) {
      const [codPlan, user] = await Promise.all([
        CodPlan.findOne({ user: remittance.userId }),
        User.findById(remittance.userId),
      ]);

      if (!codPlan || !codPlan.planName) {
        console.log(
          `No plan for user ${remittance.userId}. Assigning default D+7 plan.`
        );
        await new CodPlan({ user: remittance.userId, planName: "D+7" }).save();
        continue;
      }

      const planDays = parseInt(codPlan.planName.replace(/\D/g, ""), 10);

      const startOfTodayUTC = new Date(
        Date.UTC(
          today.getUTCFullYear(),
          today.getUTCMonth(),
          today.getUTCDate()
        )
      );
      const deliveryUTC = new Date(
        Date.UTC(
          remittance.deliveryDate.getUTCFullYear(),
          remittance.deliveryDate.getUTCMonth(),
          remittance.deliveryDate.getUTCDate()
        )
      );
      const dayDiff = Math.floor(
        (startOfTodayUTC - deliveryUTC) / (1000 * 60 * 60 * 24)
      );

      // Only check remittance eligibility
      const shouldRemitToday =
        isNotSunday &&
        ([1, 4, 7].includes(planDays) ||
          (planDays === 2 && isTodayMWF) ||
          (planDays === 3 && isTodayTF) ||
          dayDiff > planDays);

      let uniqueId;
      do {
        uniqueId = Math.floor(10000 + Math.random() * 90000);
      } while (await adminCodRemittance.findOne({ remitanceId: uniqueId }));

      // Only store minimal info if not due (raw data, no business calculation)
      const remittanceEntry = {
        date: today,
        userId: remittance.userId,
        userName: user ? user.fullname : "",
        remitanceId: uniqueId,
        totalCod: remittance.totalCod,
        orderDetails: {
          date: today,
          codcal: remittance.totalCod,
          orders: [...remittance.orderIds],
        },
        deliveryDate: remittance.deliveryDate,
        status: "Pending",
        planName: codPlan.planName,
        planDays: planDays,
      };
      // console.log("remittanceEntry", remittanceEntry);
      if (shouldRemitToday) {
        // Push directly to adminCodRemittance using business logic
        await processAndRemit(remittanceEntry);
      } else {
        // Save to afterPlan (no calculation yet)
        await new afterPlan(remittanceEntry).save();
      }

      // Mark delivered as processed
      await SameDateDelivered.updateOne(
        { _id: remittance._id },
        { $set: { status: "Completed" } }
      );
    }
  } catch (error) {
    console.error("❌ Error in remittance schedule:", error);
  }
};

if (process.env.NODE_ENV === "production") {
  cron.schedule(
    "45 1 * * *",
    () => {
      console.log(
        "⏰ Running scheduled task at 1:45 AM IST (production): Fetching orders..."
      );
      remittanceScheduleData();
    },
    {
      scheduled: true,
      timezone: "Asia/Kolkata",
    }
  );
} else {
  console.log("⚙️ Cron job not started (development/local environment)");
}

// remittanceScheduleData();

// Helper for direct business logic (used in both controllers)
const processAndRemit = async (plan) => {
  // Fetch fresh user, codPlan, wallet, codRemittance:
  const [user, codPlan, remittanceData] = await Promise.all([
    User.findById(plan.userId),
    CodPlan.findOne({ user: plan.userId }),
    codRemittance.findOne({ userId: plan.userId }),
  ]);

  if (!user || !codPlan || !remittanceData) {
    console.log(`Missing data for user ${plan.userId}, skipping...`);
    return;
  }

  // Now fetch the wallet using the user's wallet reference
  const wallet = await Wallet.findById(user.Wallet);

  if (!wallet) {
    console.log(`Missing wallet for user ${plan.userId}, skipping...`);
    return;
  }

  const planDays = parseInt(codPlan.planName.replace(/\D/g, ""), 10);
  const planCharges = codPlan.planCharges || 0;
  const deliveryDate =
    plan.deliveryDate ||
    (plan.orderDetails?.date ? new Date(plan.orderDetails.date) : new Date());
  const today = new Date();
  const startOfTodayUTC = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  );
  const deliveryUTC = new Date(
    Date.UTC(
      deliveryDate.getUTCFullYear(),
      deliveryDate.getUTCMonth(),
      deliveryDate.getUTCDate()
    )
  );
  const dayDiff = Math.floor(
    (startOfTodayUTC - deliveryUTC) / (1000 * 60 * 60 * 24)
  );

  // CodRemittance logic as per your initial approach
  // We'll use totalCod from the raw plan for calculation
  let rechargeAmount = remittanceData.rechargeAmount || 0;
  let extraAmount = 0,
    remainingRecharge = 0;
  let creditedAmount = 0,
    afterWallet = wallet.balance;
  const totalCod = plan.totalCod || 0;

  if (rechargeAmount <= totalCod) {
    remainingRecharge = totalCod - rechargeAmount;
    extraAmount = rechargeAmount;
    rechargeAmount = 0;
  } else {
    rechargeAmount -= totalCod;
    extraAmount = totalCod;
    remainingRecharge = 0;
  }

  // Deduction/adjustment logic
  if (wallet.balance < 0) {
    const adjustAmount = Math.min(remainingRecharge, Math.abs(wallet.balance));
    creditedAmount = adjustAmount;
    remainingRecharge -= adjustAmount;
    afterWallet += adjustAmount;

    // ✅ Create transaction only when adjustment happens
    const transactionEntry = {
      channelOrderId: "" || null,
      category: "credit",
      amount: creditedAmount,
      balanceAfterTransaction: afterWallet,
      awb_number: "" || null,
      description: "COD Adjustment credited to wallet",
    };

    await Wallet.updateOne(
      { _id: wallet._id },
      {
        $set: { balance: afterWallet },
        $push: { transactions: transactionEntry },
      }
    );
  } else {
    // No adjustment → only update balance
    await Wallet.updateOne(
      { _id: wallet._id },
      { $set: { balance: afterWallet } }
    );
  }

  // Charges
  const charges = Number(((remainingRecharge * planCharges) / 100).toFixed(2));
  const TotalDeduction = Number(
    (charges + creditedAmount + extraAmount).toFixed(2)
  );
  const codToBeRemitted = Number(remittanceData.CODToBeRemitted);
  const codToBeDeducted = remainingRecharge;
  // Prepare remittance entry
  const totalCodResult = Number((remainingRecharge - charges).toFixed(2));
  const remittanceEntryForUser = {
    date: today,
    remittanceId: plan.remitanceId,
    codAvailable: Number(totalCodResult.toFixed(2)),
    amountCreditedToWallet: extraAmount,
    adjustedAmount: creditedAmount,
    earlyCodCharges: Number(charges.toFixed(2)),
    status: totalCodResult === 0 ? "Paid" : "Pending",
    orderDetails: plan.orderDetails,
  };
  // Actual payout to client (deduct charges here)
  const payoutToClient = Number((remainingRecharge - charges).toFixed(2));

  // Update codRemittance
  await codRemittance.findOneAndUpdate(
    { userId: plan.userId, CODToBeRemitted: { $gte: codToBeDeducted } }, // ensure enough COD
    {
      $inc: {
        CODToBeRemitted: -remainingRecharge,
        RemittanceInitiated: payoutToClient,
        TotalDeductionfromCOD: TotalDeduction,
      },
      $set: { rechargeAmount },
      $push: { remittanceData: remittanceEntryForUser },
    },
    { new: true }
  );

  const adminEntry = {
    date: today,
    userId: plan.userId,
    userName: user.fullname,
    remitanceId: plan.remitanceId,
    totalCod: Number(totalCodResult.toFixed(2)),
    amountCreditedToWallet: extraAmount,
    adjustedAmount: creditedAmount,
    earlyCodCharges: Number(charges.toFixed(2)),
    status: totalCodResult === 0 ? "Paid" : "Pending",
    orderDetails: plan.orderDetails,
  };

  // Save to adminCodRemittance and remittanceData
  await Promise.all([new adminCodRemittance(adminEntry).save()]);
};

const fetchExtraData = async () => {
  try {
    const today = new Date();
    const day = today.getDay(); // 0 = Sunday
    const isNotSunday = day !== 0;
    const isTodayMWF = [1, 3, 5].includes(day);
    const isTodayTF = [2, 5].includes(day);

    const afterCodPlans = await afterPlan.find();

    for (const plan of afterCodPlans) {
      const codPlan = await CodPlan.findOne({ user: plan.userId });
      if (!codPlan || !codPlan.planName) {
        console.log(`⛔ Skipping: No COD plan for user ${plan.userId}`);
        continue;
      }

      const planDays = parseInt(codPlan.planName.replace(/\D/g, ""), 10);
      const planOrderDate =
        plan.deliveryDate ||
        (plan.orderDetails?.date ? new Date(plan.orderDetails.date) : today);
      const dayDiff = Math.floor(
        (today - new Date(planOrderDate)) / (1000 * 60 * 60 * 24)
      );
      const shouldMoveToAdmin =
        (isNotSunday &&
          ([1, 4, 7].includes(planDays) ||
            (planDays === 2 && isTodayMWF) ||
            (planDays === 3 && isTodayTF))) ||
        dayDiff >= planDays;

      if (!shouldMoveToAdmin) {
        console.log(`⏭️ Skipping user ${plan.userId}: Not yet due`);
        continue;
      }

      // ⇒ RECALCULATE before remitting
      await processAndRemit(plan);

      // Remove from afterPlan
      await afterPlan.findByIdAndDelete(plan._id);

      console.log(`✅ Migrated and recalculated COD for user: ${plan.userId}`);
    }
  } catch (error) {
    console.error("❌ Error in fetchExtraData:", error.message);
  }
};

if (process.env.NODE_ENV === "production") {
  cron.schedule(
    "25 2 * * *",
    () => {
      console.log(
        "⏰ Running scheduled task at 2:25 AM IST (production): Migrating afterPlan with recalculation..."
      );
      fetchExtraData();
    },
    {
      scheduled: true,
      timezone: "Asia/Kolkata",
    }
  );
} else {
  console.log("⚙️ Cron job not started (development/local environment)");
}

// fetchExtraData();

const codRemittanceData = async (req, res) => {
  try {
    const {
      id,
      fromDate,
      toDate,
      remittanceIdFilter,
      utrFilter,
      statusFilter,
    } = req.query;

    const page = Number(req.query.page) || 1;
    const limitQuery = req.query.limit;
    const limit =
      !limitQuery || limitQuery === "All" ? null : Number(limitQuery);
    const skip = limit ? (page - 1) * limit : 0;

    const userId = id || req.user._id;

    const remittanceDoc = await codRemittance.findOne({ userId }).lean();
    if (!remittanceDoc) {
      return res.status(404).json({
        success: false,
        message: "No remittance data found for this user",
      });
    }

    // ---- Apply filters only on remittanceData ----
    let rows = Array.isArray(remittanceDoc.remittanceData)
      ? remittanceDoc.remittanceData
      : [];

    if (remittanceIdFilter) {
      const terms = remittanceIdFilter.split(",").map((s) => s.trim());
      rows = rows.filter((e) =>
        terms.some((t) => String(e.remittanceId || "").includes(t))
      );
    }

    if (utrFilter) {
      const terms = utrFilter.split(",").map((s) => s.trim());
      rows = rows.filter((e) =>
        terms.some((t) => String(e.utr || "").includes(t))
      );
    }

    if (statusFilter) {
      rows = rows.filter((e) => e.status === statusFilter.trim());
    }

    if (fromDate && toDate) {
      const start = new Date(fromDate);
      start.setHours(0, 0, 0, 0);
      const end = new Date(toDate);
      end.setHours(23, 59, 59, 999);
      rows = rows.filter((e) => {
        const d = new Date(e.date);
        return d >= start && d <= end;
      });
    }

    // ---- Sort newest first ----
    rows.sort((a, b) => new Date(b.date) - new Date(a.date));

    // ---- Pagination ----
    const totalCount = rows.length;
    const totalPages = limit ? Math.ceil(totalCount / limit) : 1;
    const paginated = limit ? rows.slice(skip, skip + limit) : rows;

    return res.status(200).json({
      success: true,
      message: "COD remittance data retrieved successfully",
      total: totalCount,
      page,
      limit: limit || "All",
      totalPages,
      data: {
        // ✅ Take directly from DB document
        TotalCODRemitted: Number(remittanceDoc.TotalCODRemitted || 0),
        TotalDeductionfromCOD: Number(remittanceDoc.TotalDeductionfromCOD || 0),
        RemittanceInitiated: Number(remittanceDoc.RemittanceInitiated || 0),
        CODToBeRemitted: Number(remittanceDoc.CODToBeRemitted || 0),
        LastCODRemitted: Number(remittanceDoc.LastCODRemitted || 0),
        rechargeAmount: Number(remittanceDoc.rechargeAmount || 0),

        // Only filtered + paginated rows
        remittanceData: paginated,
      },
    });
  } catch (error) {
    console.error("Error fetching COD remittance data:", error);
    return res.status(500).json({
      success: false,
      message: "An error occurred while retrieving COD remittance data",
      error: error.message,
    });
  }
};

const getCodRemitance = async (req, res) => {
  try {
    const user = req.user._id;
    const remittanceRecord = await codRemittance.findOne({ userId: user });
    if (!remittanceRecord) {
      return res
        .status(404)
        .json({ message: "No COD remittance record found." });
    }

    return res.status(200).json({
      remittance: remittanceRecord.CODToBeRemitted,
    });
  } catch (error) {
    console.error("Error fetching COD remittance:", error);
    return res
      .status(500)
      .json({ message: "Failed to retrieve COD remittance data." });
  }
};

const codRemittanceRecharge = async (req, res) => {
  try {
    const userId = req.user._id;
    const { amount, walletId } = req.body;

    // Validate amount
    if (!amount || isNaN(amount) || amount <= 0) {
      return res.status(400).json({ message: "Invalid recharge amount" });
    }

    // ✅ Find user correctly
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // ✅ Fetch all COD orders for this user (Pending)
    const allCodRemittanceOrder = await CodRemittanceOrdersModel.find({
      Email: user.email,
      status: "Pending",
    }).sort({ Date: 1 }); // optional: sort oldest first

    const remittanceRecord = await codRemittance.findOne({ userId }).lean();
    if (!remittanceRecord) {
      return res.status(404).json({ message: "Remittance record not found" });
    }

    // Calculate actual pending COD available from remittanceData
    const pendingCodAvailable = Array.isArray(remittanceRecord.remittanceData)
      ? remittanceRecord.remittanceData
          .filter((r) => r.status === "Pending")
          .reduce((sum, r) => sum + Number(r.codAvailable || 0), 0)
      : 0;

    // Determine the lower value between RemittanceInitiated and pendingCodAvailable
    const effectivePending = Math.min(
      Number(remittanceRecord.RemittanceInitiated || 0),
      pendingCodAvailable
    );

    // Check if requested recharge exceeds effective pending amount
    if (amount > remittanceRecord.CODToBeRemitted) {
      return res.status(400).json({
        message: "Insufficient COD Available Balance",
        available: effectivePending,
      });
    }

    const currentWallet = await Wallet.findById(walletId);
    if (!currentWallet) {
      return res.status(404).json({ message: "Wallet not found" });
    }

    // ✅ Deduct amount against COD Orders
    let remainingAmount = amount;
    let fulfilledOrders = [];

    for (const order of allCodRemittanceOrder) {
      let codValue = Number(order.CODAmount);

      if (remainingAmount >= codValue) {
        // Full payment for this order
        await CodRemittanceOrdersModel.updateOne(
          { _id: order._id },
          { $set: { status: "Paid" } }
        );
        fulfilledOrders.push(order.orderID);
        remainingAmount -= codValue;
      } else if (remainingAmount > 0) {
        // Partial payment
        const newValue = codValue - remainingAmount;

        await CodRemittanceOrdersModel.updateOne(
          { _id: order._id },
          { $set: { CODAmount: newValue } }
        );
        remainingAmount = 0;
        break;
      }
      if (remainingAmount <= 0) break;
    }

    // ✅ Update remittance record
    await codRemittance.updateOne(
      { _id: remittanceRecord._id },
      {
        $inc: {
          CODToBeRemitted: -amount,
          rechargeAmount: amount,
          // RemittanceInitiated: -amount,
        },
      }
    );

    // ✅ Push transaction and update wallet balance
    await currentWallet.updateOne({
      $inc: { balance: amount },
      $push: {
        transactions: {
          category: "credit",
          amount,
          balanceAfterTransaction: currentWallet.balance + amount,
          date: new Date(),
          description: "Recharge from COD Remittance",
        },
      },
    });

    return res.status(200).json({
      success: true,
      message: "COD remittance recharge processed successfully.",
      rechargedAmount: amount,
      fulfilledOrders,
      remainingBalance: remainingAmount,
    });
  } catch (error) {
    console.error("Error processing COD remittance recharge:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to process COD remittance recharge.",
      error: error.message,
    });
  }
};

const downloadSampleExcel = async (req, res) => {
  try {
    // Create a new workbook and add a worksheet
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Sample Bulk Order");

    // Define headers
    worksheet.columns = [
      { header: "*RemittanceID", key: "RemittanceID", width: 30 },
      { header: "*UTR", key: "UTR", width: 40 },
      // { header: "*CODAmount", key: "CODAmount", width: 40 },
    ];

    // Add a sample row with mandatory product 1 and optional products
    worksheet.addRow({
      RemittanceID: "57432",
      UTR: "PAY67890",
      // CODAmount: "1000",
    });

    // Format the header row
    worksheet.getRow(1).eachCell((cell) => {
      cell.alignment = { vertical: "middle", horizontal: "center" };
      cell.font = { bold: true }; // Make headers bold
    });

    // Set response headers for file download
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", "attachment; filename=sample.xlsx");

    // Write workbook to response stream
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error("Error generating Excel file:", error);
    res
      .status(500)
      .json({ error: "Error generating Excel file", details: error.message });
  }
};

function parseCSV(filePath, fileData) {
  return new Promise((resolve, reject) => {
    const orders = [];
    fs.createReadStream(filePath)
      .pipe(csv())
      .on("data", async (row) => {
        // orders.push(row);
        try {
          const order = new bulkOrdersCSV({
            fileId: fileData._id,
            orderId: row["*Order Id"],
            orderDate: row["Order Date as dd-mm-yyyy hh:MM"] || null,
            channel: row["*Channel"],
            paymentMethod: row["*Payment Method(COD/Prepaid)"],
            customer: {
              firstName: row["*Customer First Name"],
              lastName: row["Customer Last Name"] || "",
              email: row["Email (Optional)"] || "",
              mobile: row["*Customer Mobile"],
              alternateMobile: row["Customer Alternate Mobile"] || "",
            },
            shippingAddress: {
              line1: row["*Shipping Address Line 1"],
              line2: row["Shipping Address Line 2"] || "",
              country: row["*Shipping Address Country"],
              state: row["*Shipping Address State"],
              city: row["*Shipping Address City"],
              postcode: row["*Shipping Address Postcode"],
            },
            billingAddress: {
              line1: row["Billing Address Line 1"] || "",
              line2: row["Billing Address Line 2"] || "",
              country: row["Billing Address Country"] || "",
              state: row["Billing Address State"] || "",
              city: row["Billing Address City"] || "",
              postcode: row["Billing Address Postcode"] || "",
            },
            orderDetails: {
              masterSKU: row["*Master SKU"],
              name: row["*Product Name"],
              quantity: parseInt(row["*Product Quantity"]) || 0,
              taxPercentage: parseFloat(row["Tax %"]),
              sellingPrice: parseFloat(
                row["*Selling Price(Per Unit Item, Inclusive of Tax)"]
              ),
              discount: parseFloat(row["Discount(Per Unit Item)"]) || 0,
              shippingCharges: parseFloat(
                row["Shipping Charges(Per Order)"] || 0
              ),
              codCharges: parseFloat(row["COD Charges(Per Order)"] || 0),
              giftWrapCharges: parseFloat(
                row["Gift Wrap Charges(Per Order)"] || 0
              ),
              totalDiscount: parseFloat(row["Total Discount (Per Order)"] || 0),
              dimensions: {
                length: parseFloat(row["*Length (cm)"]),
                breadth: parseFloat(row["*Breadth (cm)"]),
                height: parseFloat(row["*Height (cm)"]),
              },
              weight: parseFloat(row["*Weight Of Shipment(kg)"]),
            },
            sendNotification:
              row["Send Notification(True/False)"].toLowerCase() === "true",
            comment: row["Comment"] || "",
            hsnCode: row["HSN Code"] || "",
            locationId: row["Location Id"] || "",
            resellerName: row["Reseller Name"] || "",
            companyName: row["Company Name"] || "",
            latitude: parseFloat(row["latitude"] || 0),
            longitude: parseFloat(row["longitude"] || 0),
            verifiedOrder: row["Verified Order"] === "1",
            isDocuments: row["Is documents"] || "No",
            orderType: row["Order Type"] || "",
            orderTag: row["Order tag"] || "",
          });
          await order.save();
          console.log(`Imported order: ${order.orderId}`);
        } catch (error) {
          console.error(`Error importing order: ${row["*Order Id"]}`, error);
        }
      })
      .on("end", () => {
        console.log("CSV file successfully processed");
        resolve(orders);
      })
      .on("error", (error) => {
        console.log("CSV Parsing error:", error);
        reject(error);
      });
  });
}

// Helper function to read Excel file (.xlsx, .xls)
function parseExcel(filePath) {
  const workbook = xlsx.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const data = xlsx.utils.sheet_to_json(sheet);
  return data;
}

const uploadCodRemittance = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    // Save file metadata
    const fileData = new File({
      filename: req.file.filename,
      date: new Date(),
      status: "Processing",
    });
    await fileData.save();

    // Determine file extension
    const fileExtension = path.extname(req.file.originalname).toLowerCase();
    let codRemittances = [];

    if (fileExtension === ".csv") {
      codRemittances = await parseCSV(req.file.path, fileData);
    } else if (fileExtension === ".xlsx" || fileExtension === ".xls") {
      codRemittances = await parseExcel(req.file.path);
    } else {
      return res.status(400).json({ error: "Unsupported file format" });
    }

    if (!codRemittances || codRemittances.length === 0) {
      return res
        .status(400)
        .json({ error: "The uploaded file is empty or contains invalid data" });
    }

    for (const row of codRemittances) {
      const remittance = await adminCodRemittance.findOne({
        remitanceId: row["*RemittanceID"],
      });

      if (!remittance) {
        return res
          .status(400)
          .json({ error: `Remittance ID ${row["*RemittanceID"]} not found.` });
      }

      if (remittance.status === "Paid") {
        console.log(
          `Remittance ID ${row["*RemittanceID"]} is already paid. Skipping reprocessing.`
        );
        continue;
      }

      let userRemittance = await codRemittance.findOne({
        userId: remittance.userId,
      });

      if (!userRemittance) {
        userRemittance = new codRemittance({
          userId: remittance.userId,
          TotalCODRemitted: 0,
          RemittanceInitiated: 0,
          remittanceData: [],
        });
        await userRemittance.save();
      }

      // Ensure numeric fields
      userRemittance.TotalCODRemitted ??= 0;
      userRemittance.RemittanceInitiated ??= 0;
      userRemittance.remittanceData ??= [];

      const currentRemittanceEntry = userRemittance.remittanceData.find(
        (entry) => entry.remittanceId === remittance.remitanceId
      );

      if (currentRemittanceEntry) {
        const actualAmount = Number(currentRemittanceEntry.codAvailable || 0);

        if (actualAmount > 0) {
          if (userRemittance.RemittanceInitiated >= actualAmount) {
            userRemittance.RemittanceInitiated -= actualAmount;
            userRemittance.LastCODRemitted = actualAmount;
          } else {
            console.warn(
              `RemittanceInitiated (${userRemittance.RemittanceInitiated}) less than actualAmount (${actualAmount}), skipping deduction to avoid negative value.`
            );
          }
        } else {
          console.warn(
            `Actual amount is zero or negative (${actualAmount}), no deduction.`
          );
        }

        // Mark all orders as Paid
        for (const item of remittance.orderDetails.orders) {
          const order = await Order.findOne({ _id: item });
          if (!order) {
            console.log(`Order with ID ${item} not found.`);
            continue;
          }
          await CodRemittanceOrdersModel.findOneAndUpdate(
            { orderID: order.orderId },
            { $set: { status: "Paid" } }
          );
        }
      } else {
        console.warn(
          `No remittanceData entry found for remittanceId ${remittance.remitanceId}`
        );
      }

      // ✅ Only update TotalCODRemitted
      userRemittance.TotalCODRemitted += Number(remittance.totalCod || 0);

      // ✅ Safety check
      if (isNaN(userRemittance.TotalCODRemitted)) {
        console.error("Invalid TotalCODRemitted detected:", {
          TotalCODRemitted: userRemittance.TotalCODRemitted,
        });
        return res
          .status(500)
          .json({ error: "Invalid TotalCODRemitted value" });
      }

      // Update or add entry
      const existingRemittanceEntryIndex =
        userRemittance.remittanceData.findIndex(
          (entry) => entry.remittanceId === remittance.remitanceId
        );

      if (existingRemittanceEntryIndex !== -1) {
        userRemittance.remittanceData[existingRemittanceEntryIndex].utr =
          row["*UTR"] || "N/A";
        userRemittance.remittanceData[
          existingRemittanceEntryIndex
        ].remittanceMethod = "Bank Transaction";
        userRemittance.remittanceData[existingRemittanceEntryIndex].status =
          "Paid";
      } else {
        userRemittance.remittanceData.push({
          date: remittance.date,
          remittanceId: remittance.remitanceId,
          utr: row["*UTR"] || "N/A",
          codAvailable: remittance.totalCod || 0,
          amountCreditedToWallet: remittance.amountCreditedToWallet || 0,
          earlyCodCharges: remittance.earlyCodCharges || 0,
          adjustedAmount: remittance.adjustedAmount || 0,
          remittanceMethod: "Bank Transaction",
          status: "Paid",
          orderDetails: {
            date: remittance.orderDetails.date,
            codcal: remittance.orderDetails.codcal,
            orders: [...remittance.orderDetails.orders],
          },
        });
      }

      await userRemittance.save();

      remittance.status = "Paid";
      await remittance.save();
    }

    // Delete uploaded file
    fs.unlink(req.file.path, (err) => {
      if (err) console.error("Error deleting file:", err);
    });

    return res.status(200).json({
      message: "COD Remittance uploaded successfully",
      file: fileData,
    });
  } catch (error) {
    console.error("Error in uploadCodRemittance:", error);
    res
      .status(500)
      .json({ error: "An error occurred while processing the file" });
  }
};

const CheckCodplan = async (req, res) => {
  try {
    // console.log("reddd", req.query);
    const { id } = req.query;
    const userId = id || req.user?._id; // Ensure req.user exists
    if (!userId) {
      return res.status(400).json({ error: "User ID not found" });
    }

    const codplans = await CodPlan.findOne({ user: userId });
    const codplaneName = codplans.planName;
    // console.log("ffff",codplaneName)
    // console.log("kkdkdkd",codplans)
    res
      .status(200)
      .json({ message: "User ID retrieved successfully", codplaneName });
  } catch (error) {
    console.error("Error in checkCodPlan:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

const remittanceTransactionData = async (req, res) => {
  try {
    const { id } = req.params; // Remittance ID
    const userID = req.user._id;

    if (!id) {
      return res.status(400).json({
        success: false,
        message: "Remittance ID is required.",
      });
    }

    // Fetch remittance data for the current user
    const remittanceData = await codRemittance
      .findOne({ userId: userID })
      .lean();
    if (!remittanceData) {
      return res.status(404).json({
        success: false,
        message: "Remittance data not found.",
      });
    }

    // Find the specific remittance transaction
    const result = remittanceData.remittanceData.find(
      (item) => String(item.remittanceId) === String(id)
    );
    if (!result) {
      return res.status(404).json({
        success: false,
        message: "Transaction not found.",
      });
    }

    if (!result.orderDetails || !Array.isArray(result.orderDetails.orders)) {
      return res.status(400).json({
        success: false,
        message: "Invalid remittance order details.",
      });
    }

    // Fetch all orders in a single query for performance
    const orderdata = await Order.find({
      _id: { $in: result.orderDetails.orders },
    }).lean();

    // Parallel fetch: Bank details + Wallet info
    const [bankDetails, user] = await Promise.all([
      BankAccountDetails.findOne({ user: userID }).lean(),
      users.findById(userID).lean(),
    ]);

    const wallet = user?.Wallet
      ? await Wallet.findById(user.Wallet).lean()
      : null;

    // Construct the response object (aligned with seller controller)
    const transactions = {
      remittanceId: id,
      date: result.date || "N/A",
      totalOrder: orderdata.length,
      totalCOD: result.orderDetails?.codcal || 0,
      remittanceAmount: result.codAvailable || 0,
      deliveryDate: result.orderDetails?.date || "N/A",
      status: result.status || "N/A",
      orderDataInArray: orderdata,
      bankDetails: {
        accountHolderName: bankDetails?.nameAtBank || "N/A",
        accountNumber: bankDetails?.accountNumber || "N/A",
        ifscCode: bankDetails?.ifsc || "N/A",
        bankName: bankDetails?.bank || "N/A",
        branchName: bankDetails?.branch || "N/A",
        balance: wallet?.balance || 0,
      },
    };

    return res.status(200).json({
      success: true,
      message: "Remittance transaction data retrieved successfully.",
      data: transactions,
    });
  } catch (error) {
    console.error("Error fetching remittance transactions:", error);
    return res.status(500).json({
      success: false,
      message: "An error occurred while retrieving transaction data.",
      error: error.message,
    });
  }
};

const courierCodRemittance = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limitQuery = req.query.limit;
    const limit = limitQuery === "All" ? null : parseInt(limitQuery);
    const skip = limit ? (page - 1) * limit : 0;

    const searchFilter = req.query.searchFilter?.trim().toLowerCase() || "";
    const orderIdAwbNumberFilter =
      req.query.orderIdAwbNumberFilter?.trim() || "";
    const statusFilter = req.query.statusFilter?.trim() || "";
    const courierProvider =
      req.query.courierProvider?.trim().toLowerCase() || "";

    let matchStage = {};

    // Employee AWB restriction
    if (req.employee?.employeeId) {
      const allocations = await AllocateRole.find({
        employeeId: req.employee.employeeId,
      });
      const allocatedUserIds = allocations.map((a) =>
        a.sellerMongoId.toString()
      );

      if (allocatedUserIds.length === 0) {
        return res.status(200).json({
          success: true,
          message: "COD remittance orders retrieved successfully",
          total: 0,
          page,
          limit: limit || "All",
          totalPages: 1,
          data: {
            totalCODAmount: 0,
            paidCODAmount: 0,
            pendingCODAmount: 0,
            orders: [],
          },
        });
      }

      const orders = await Order.find(
        {
          userId: {
            $in: allocatedUserIds.map((id) => new mongoose.Types.ObjectId(id)),
          },
        },
        { awb_number: 1 }
      ).lean();

      const allowedAwbNumbers = orders
        .map((o) => o.awb_number?.toString())
        .filter(Boolean);
      if (allowedAwbNumbers.length === 0) {
        return res.status(200).json({
          success: true,
          message: "No COD remittance orders for this employee",
          total: 0,
          page,
          limit: limit || "All",
          totalPages: 1,
          data: {
            totalCODAmount: 0,
            paidCODAmount: 0,
            pendingCODAmount: 0,
            orders: [],
          },
        });
      }

      matchStage.AwbNumber = { $in: allowedAwbNumbers };
    }

    // Search filter
    if (searchFilter) {
      matchStage.$or = [
        { userName: { $regex: searchFilter, $options: "i" } },
        { PhoneNumber: { $regex: searchFilter, $options: "i" } },
        { Email: { $regex: searchFilter, $options: "i" } },
      ];
    }

    // Order ID / AWB filter
    if (orderIdAwbNumberFilter) {
      const filterValues = orderIdAwbNumberFilter
        .split(",")
        .map((v) => v.trim());
      matchStage.$or = (matchStage.$or || []).concat([
        { orderID: { $in: filterValues } },
        { AwbNumber: { $in: filterValues } },
      ]);
    }

    // Status filter
    if (statusFilter) {
      matchStage.status = { $regex: statusFilter, $options: "i" };
    }

    // Courier provider filter
    if (courierProvider) {
      matchStage.courierProvider = { $regex: courierProvider, $options: "i" };
    }

    // Fetch and paginate in MongoDB
    const aggregationPipeline = [
      { $match: matchStage },
      {
        $addFields: {
          codAmountNum: { $toDouble: { $ifNull: ["$CODAmount", 0] } },
        },
      },
      { $sort: { _id: -1 } },
    ];

    if (limit) {
      aggregationPipeline.push({ $skip: skip }, { $limit: limit });
    }

    const orders = await CourierCodRemittance.aggregate(aggregationPipeline);

    // Calculate totals directly in DB
    const totalsAgg = await CourierCodRemittance.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: null,
          totalCODAmount: {
            $sum: { $toDouble: { $ifNull: ["$CODAmount", 0] } },
          },
          paidCODAmount: {
            $sum: {
              $cond: [
                { $eq: ["$status", "Paid"] },
                { $toDouble: { $ifNull: ["$CODAmount", 0] } },
                0,
              ],
            },
          },
          pendingCODAmount: {
            $sum: {
              $cond: [
                { $eq: ["$status", "Pending"] },
                { $toDouble: { $ifNull: ["$CODAmount", 0] } },
                0,
              ],
            },
          },
        },
      },
    ]);

    const totals = totalsAgg[0] || {
      totalCODAmount: 0,
      paidCODAmount: 0,
      pendingCODAmount: 0,
    };

    const totalCount = await CourierCodRemittance.countDocuments(matchStage);
    const totalPages = limit ? Math.ceil(totalCount / limit) : 1;

    return res.status(200).json({
      success: true,
      message: "COD remittance orders retrieved successfully",
      total: totalCount,
      page,
      limit: limit || "All",
      totalPages,
      data: { ...totals, orders },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "An error occurred while retrieving COD remittance orders",
      error: error.message,
    });
  }
};

const getAdminCodRemitanceData = async (req, res) => {
  try {
    const {
      userNameFilter,
      selectedUserId,
      startDate,
      endDate,
      statusFilter,
      page = 1,
      limit = 20,
      remittanceIdFilter,
      utr,
    } = req.query;

    // console.log("query", req.query);

    const parsedLimit = limit === "all" ? 0 : Number(limit);
    const skip = (Number(page) - 1) * (parsedLimit || 0);

    // ---------- Base filters ----------
    const userIdFilter = {};
    const remittanceMatchStage = {};

    // Employee allocation filter (optional: applies if there is employee context)
    if (req.employee?.employeeId) {
      const allocations = await AllocateRole.find({
        employeeId: req.employee.employeeId,
      });
      const allocatedUserIds = allocations.map(
        (a) => new mongoose.Types.ObjectId(a.sellerMongoId)
      );
      if (allocatedUserIds.length === 0) {
        return res.json({
          total: 0,
          page: Number(page),
          limit: parsedLimit === 0 ? "all" : parsedLimit,
          results: [],
          summary: {
            CODToBeRemitted: 0,
            RemittanceInitiated: 0,
            TotalDeductionfromCOD: 0,
            TotalCODRemitted: 0,
            LastCodRemmited: null,
          },
        });
      }
      userIdFilter.userId = { $in: allocatedUserIds };
    }

    // Add filtering by selectedUserId if provided
    if (selectedUserId) {
      try {
        userIdFilter.userId = new mongoose.Types.ObjectId(selectedUserId);
      } catch {
        return res.status(400).json({ message: "Invalid selectedUserId" });
      }
    }

    // Date filter
    if (startDate && endDate) {
      const sDate = new Date(startDate);
      sDate.setHours(0, 0, 0, 0);
      const eDate = new Date(endDate);
      eDate.setHours(23, 59, 59, 999);
      remittanceMatchStage["remittanceData.date"] = {
        $gte: sDate,
        $lte: eDate,
      };
    }

    // Status / remittanceId / utr filters on remittanceData
    if (statusFilter)
      remittanceMatchStage["remittanceData.status"] = statusFilter;
    if (remittanceIdFilter)
      remittanceMatchStage["remittanceData.remittanceId"] = remittanceIdFilter;
    if (utr) remittanceMatchStage["remittanceData.utr"] = utr;

    // Base pipeline for user lookup and filtering user data
    const basePipeline = [
      { $match: userIdFilter },
      {
        $lookup: {
          from: "users",
          localField: "userId",
          foreignField: "_id",
          as: "user",
        },
      },
      { $unwind: "$user" },
      ...(userNameFilter
        ? [
            {
              $match: {
                $or: [
                  ...(mongoose.Types.ObjectId.isValid(userNameFilter)
                    ? [
                        {
                          "user._id": new mongoose.Types.ObjectId(
                            userNameFilter
                          ),
                        },
                      ]
                    : []),
                  { "user.email": new RegExp(userNameFilter, "i") },
                  { "user.fullname": new RegExp(userNameFilter, "i") },
                ],
              },
            },
          ]
        : []),
    ];

    // Work on remittanceData - unwind first, then apply remittance filters
    const remittanceFilteringPipeline = [
      { $unwind: "$remittanceData" },
      { $match: remittanceMatchStage },
    ];

    // Group by remittanceId to get unique remittance entries
    const groupByRemittanceId = {
      $group: {
        _id: "$remittanceData.remittanceId",
        doc: { $first: "$$ROOT" },
      },
    };

    const replaceRoot = { $replaceRoot: { newRoot: "$doc" } };

    // Add fields: numeric conversions and sum for codAvailable and related amounts
    const addFieldsForNumbers = {
      $addFields: {
        codAvailableNum: {
          $toDouble: {
            $ifNull: [
              {
                $cond: [
                  {
                    $and: [
                      { $isArray: "$remittanceData.codAvailable" },
                      { $gt: [{ $size: "$remittanceData.codAvailable" }, 0] },
                    ],
                  },
                  { $arrayElemAt: ["$remittanceData.codAvailable", 0] },
                  "$remittanceData.codAvailable",
                ],
              },
              0,
            ],
          },
        },
        amountCreditedToWalletNum: {
          $toDouble: {
            $ifNull: [
              {
                $cond: [
                  {
                    $and: [
                      { $isArray: "$remittanceData.amountCreditedToWallet" },
                      {
                        $gt: [
                          { $size: "$remittanceData.amountCreditedToWallet" },
                          0,
                        ],
                      },
                    ],
                  },
                  {
                    $arrayElemAt: ["$remittanceData.amountCreditedToWallet", 0],
                  },
                  "$remittanceData.amountCreditedToWallet",
                ],
              },
              0,
            ],
          },
        },
        earlyCodChargesNum: {
          $toDouble: {
            $ifNull: [
              {
                $cond: [
                  {
                    $and: [
                      { $isArray: "$remittanceData.earlyCodCharges" },
                      {
                        $gt: [{ $size: "$remittanceData.earlyCodCharges" }, 0],
                      },
                    ],
                  },
                  { $arrayElemAt: ["$remittanceData.earlyCodCharges", 0] },
                  "$remittanceData.earlyCodCharges",
                ],
              },
              0,
            ],
          },
        },
        adjustedAmountNum: {
          $toDouble: {
            $ifNull: [
              {
                $cond: [
                  {
                    $and: [
                      { $isArray: "$remittanceData.adjustedAmount" },
                      { $gt: [{ $size: "$remittanceData.adjustedAmount" }, 0] },
                    ],
                  },
                  { $arrayElemAt: ["$remittanceData.adjustedAmount", 0] },
                  "$remittanceData.adjustedAmount",
                ],
              },
              0,
            ],
          },
        },
        remittanceInitiatedNum: {
          $toDouble: {
            $ifNull: [
              {
                $cond: [
                  {
                    $and: [
                      { $isArray: "$remittanceData.codAvailable" },
                      { $gt: [{ $size: "$remittanceData.codAvailable" }, 0] },
                    ],
                  },
                  { $arrayElemAt: ["$remittanceData.codAvailable", 0] },
                  "$remittanceData.codAvailable",
                ],
              },
              0,
            ],
          },
        },
        codAvailableSum: {
          $add: [
            {
              $toDouble: {
                $ifNull: [
                  {
                    $cond: [
                      {
                        $and: [
                          { $isArray: "$remittanceData.codAvailable" },
                          {
                            $gt: [{ $size: "$remittanceData.codAvailable" }, 0],
                          },
                        ],
                      },
                      { $arrayElemAt: ["$remittanceData.codAvailable", 0] },
                      "$remittanceData.codAvailable",
                    ],
                  },
                  0,
                ],
              },
            },
            {
              $toDouble: {
                $ifNull: [
                  {
                    $cond: [
                      {
                        $and: [
                          {
                            $isArray: "$remittanceData.amountCreditedToWallet",
                          },
                          {
                            $gt: [
                              {
                                $size: "$remittanceData.amountCreditedToWallet",
                              },
                              0,
                            ],
                          },
                        ],
                      },
                      {
                        $arrayElemAt: [
                          "$remittanceData.amountCreditedToWallet",
                          0,
                        ],
                      },
                      "$remittanceData.amountCreditedToWallet",
                    ],
                  },
                  0,
                ],
              },
            },
            {
              $toDouble: {
                $ifNull: [
                  {
                    $cond: [
                      {
                        $and: [
                          { $isArray: "$remittanceData.earlyCodCharges" },
                          {
                            $gt: [
                              { $size: "$remittanceData.earlyCodCharges" },
                              0,
                            ],
                          },
                        ],
                      },
                      { $arrayElemAt: ["$remittanceData.earlyCodCharges", 0] },
                      "$remittanceData.earlyCodCharges",
                    ],
                  },
                  0,
                ],
              },
            },
          ],
        },
      },
    };

    // Final projection
    const projectFields = {
      $project: {
        _id: 0,
        user: {
          userId: "$user.userId",
          name: "$user.fullname",
          email: "$user.email",
          phoneNumber: "$user.phoneNumber",
        },
        remittanceId: "$remittanceData.remittanceId",
        date: "$remittanceData.date",
        status: "$remittanceData.status",
        remittanceMethod: "$remittanceData.remittanceMethod",
        utr: "$remittanceData.utr",
        codAvailable: "$codAvailableSum", // sum of codAvailable + amountCreditedToWallet + earlyCodCharges
        remittanceInitiated: "$remittanceInitiatedNum", // original codAvailable
        amountCreditedToWallet: "$amountCreditedToWalletNum",
        earlyCodCharges: "$earlyCodChargesNum",
        adjustedAmount: "$adjustedAmountNum",
      },
    };

    const sortingAndPagination = [
      { $sort: { date: -1 } },
      ...(parsedLimit === 0 ? [] : [{ $skip: skip }, { $limit: parsedLimit }]),
    ];

    // Full pipeline for fetching results
    const rowsPipeline = [
      ...basePipeline,
      ...remittanceFilteringPipeline,
      groupByRemittanceId,
      replaceRoot,
      addFieldsForNumbers,
      projectFields,
      ...sortingAndPagination,
    ];

    const rows = await codRemittance.aggregate(rowsPipeline);

    // Count pipeline for total count
    const countPipeline = [
      ...basePipeline,
      { $unwind: "$remittanceData" },
      { $match: remittanceMatchStage },
      { $count: "total" },
    ];

    const countResult = await codRemittance.aggregate(countPipeline);
    const total = countResult[0]?.total || 0;

    // Summary aggregation: apply filters on remittanceData to get accurate summary for filtered data
    const aggregationSummary = await codRemittance.aggregate([
      { $match: userIdFilter },
      {
        $group: {
          _id: null,
          CODToBeRemitted: { $sum: "$CODToBeRemitted" },
          RemittanceInitiated: { $sum: "$RemittanceInitiated" },
          TotalDeductionfromCOD: { $sum: "$TotalDeductionfromCOD" },
          TotalCODRemitted: { $sum: "$TotalCODRemitted" },
          LastCODRemitted: { $sum: "$LastCODRemitted" }, // replace with your actual last remittance date field if any, else remove
        },
      },
      {
        $project: {
          _id: 0,
          CODToBeRemitted: 1,
          RemittanceInitiated: 1,
          TotalDeductionfromCOD: 1,
          TotalCODRemitted: 1,
          LastCODRemitted: 1,
        },
      },
    ]);

    const summary = aggregationSummary[0] || {
      CODToBeRemitted: 0,
      RemittanceInitiated: 0,
      TotalDeductionfromCOD: 0,
      TotalCODRemitted: 0,
      LastCodRemmited: 0,
    };
    const totalPages = parsedLimit === 0 ? 1 : Math.ceil(total / parsedLimit);
    res.json({
      total,
      page: Number(page),
      limit: parsedLimit === 0 ? "all" : parsedLimit,
      results: rows,
      summary,
      totalPages,
    });
  } catch (error) {
    console.error("Error in getAllCodRemittance:", error);
    res.status(500).json({ message: "Server error" });
  }
};

const CodRemittanceOrder = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limitQuery = req.query.limit;
    const limit = limitQuery === "All" ? null : parseInt(limitQuery);
    const skip = limit ? (page - 1) * limit : 0;

    const {
      searchFilter = "",
      orderIdAwbNumberFilter = "",
      statusFilter = "",
      courierProvider = "",
      startDate,
      endDate,
    } = req.query;

    let allocatedUserIds = null;
    let allowedOrderIds = null;

    // Employee role filtering
    if (req.employee?.employeeId) {
      const allocations = await AllocateRole.find({
        employeeId: req.employee.employeeId,
      });
      allocatedUserIds = allocations.map((a) => a.sellerMongoId.toString());

      if (!allocatedUserIds.length) {
        return res.status(200).json({
          success: true,
          message: "No allocated users",
          total: 0,
          data: { orders: [] },
        });
      }

      const orders = await Order.find(
        {
          userId: {
            $in: allocatedUserIds.map((id) => new mongoose.Types.ObjectId(id)),
          },
        },
        { orderId: 1 }
      ).lean();

      allowedOrderIds = orders.map((o) => o.orderId?.toString());
    }

    // Build MongoDB match object
    let matchStage = {};
    if (allowedOrderIds) {
      matchStage.orderID = { $in: allowedOrderIds };
    }
    if (statusFilter) {
      matchStage.status = statusFilter;
    }
    if (courierProvider) {
      matchStage.courierProvider = new RegExp(`^${courierProvider}$`, "i");
    }
    if (startDate && endDate) {
      matchStage.createdAt = {
        $gte: new Date(startDate),
        $lte: new Date(endDate),
      };
    }
    if (orderIdAwbNumberFilter) {
      const filterValues = orderIdAwbNumberFilter
        .split(",")
        .map((val) => val.trim());
      matchStage.$or = [
        { orderID: { $in: filterValues } },
        { AWB_Number: { $in: filterValues } },
      ];
    }

    // MongoDB aggregation
    const allOrders = await CodRemittanceOrdersModel.aggregate([
      { $match: matchStage },
      {
        $addFields: {
          codAmountNum: { $toDouble: { $ifNull: ["$CODAmount", 0] } },
        },
      },
      { $sort: { _id: -1 } },
    ]);

    // Filter by searchFilter in memory (name/phone/email search is trickier in MongoDB without $regex)
    let filteredOrders = allOrders;
    if (searchFilter) {
      const lowerCaseFilter = searchFilter.toLowerCase();
      filteredOrders = allOrders.filter(
        (order) =>
          (order.userName || "").toLowerCase().includes(lowerCaseFilter) ||
          (order.PhoneNumber || "").toLowerCase().includes(lowerCaseFilter) ||
          (order.Email || "").toLowerCase().includes(lowerCaseFilter)
      );
    }

    // Pagination
    const totalCount = filteredOrders.length;
    const totalPages = limit ? Math.ceil(totalCount / limit) : 1;
    const paginatedData = limit
      ? filteredOrders.slice(skip, skip + limit)
      : filteredOrders;

    // Totals
    const totalCODAmount = filteredOrders.reduce(
      (sum, o) => sum + (o.codAmountNum || 0),
      0
    );
    const paidCODAmount = filteredOrders
      .filter((o) => o.status === "Paid")
      .reduce((sum, o) => sum + (o.codAmountNum || 0), 0);
    const pendingCODAmount = filteredOrders
      .filter((o) => o.status === "Pending")
      .reduce((sum, o) => sum + (o.codAmountNum || 0), 0);
    console.log("pagin", paginatedData);
    return res.status(200).json({
      success: true,
      message: "COD remittance orders retrieved successfully",
      total: totalCount,
      page,
      limit: limit || "All",
      totalPages,
      data: {
        totalCODAmount,
        paidCODAmount,
        pendingCODAmount,
        orders: paginatedData,
      },
    });
  } catch (error) {
    console.error("Error fetching COD remittance orders:", error.message);
    return res.status(500).json({
      success: false,
      message: "An error occurred while retrieving COD remittance orders",
      error: error.message,
    });
  }
};

const sellerremittanceTransactionData = async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        message: "Remittance ID is required.",
      });
    }

    // Fetch remittance data
    const remittanceData = await adminCodRemittance
      .findOne({ remitanceId: id })
      .lean();
    if (!remittanceData) {
      return res.status(404).json({
        success: false,
        message: "Remittance data not found.",
      });
    }

    const userId = remittanceData.userId;

    // Parallel fetch: Bank details, User (to get Wallet ID)
    const [bankDetails, user] = await Promise.all([
      BankAccountDetails.findOne({ user: userId }).lean(),
      users.findById(userId).lean(),
    ]);

    const wallet = user?.Wallet
      ? await Wallet.findById(user.Wallet).lean()
      : null;

    // Fetch all orders in a single query
    const orderIds = remittanceData.orderDetails?.orders || [];
    const filteredOrders = orderIds.length
      ? await Order.find({ _id: { $in: orderIds } }).lean()
      : [];

    const transactions = {
      remitanceId: id,
      date: remittanceData.date || "N/A",
      totalOrder: filteredOrders.length,
      totalCOD: remittanceData.orderDetails?.codcal || 0,
      remitanceAmount: remittanceData.codAvailable || 0,
      deliveryDate: remittanceData.orderDetails?.date || "N/A",
      status: remittanceData.status || "N/A",
      orderDataInArray: filteredOrders,
      bankDetails: {
        accountHolderName: bankDetails?.nameAtBank || "N/A",
        accountNumber: bankDetails?.accountNumber || "N/A",
        ifscCode: bankDetails?.ifsc || "N/A",
        bankName: bankDetails?.bank || "N/A",
        branchName: bankDetails?.branch || "N/A",
        balance: wallet?.balance || 0,
      },
    };

    return res.status(200).json({
      success: true,
      message: "Remittance transaction data retrieved successfully.",
      data: transactions,
    });
  } catch (error) {
    console.error("Error fetching remittance transaction data:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error while retrieving transaction data.",
      error: error.message,
    });
  }
};

const CourierdownloadSampleExcel = async (req, res) => {
  try {
    // Create a new workbook and add a worksheet
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Sample Bulk Order");

    // Define headers
    worksheet.columns = [
      { header: "*AWB Number", key: "AWBNumber", width: 30 },
      { header: "*COD Amount", key: "CODAmount", width: 40 },
      // { header: "*CODAmount", key: "CODAmount", width: 40 },
    ];

    // Add a sample row with mandatory product 1 and optional products
    worksheet.addRow({
      AWBNumber: "5743267565",
      CODAmount: "500",
      // CODAmount: "1000",
    });

    // Format the header row
    worksheet.getRow(1).eachCell((cell) => {
      cell.alignment = { vertical: "middle", horizontal: "center" };
      cell.font = { bold: true }; // Make headers bold
    });

    // Set response headers for file download
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", "attachment; filename=sample.xlsx");

    // Write workbook to response stream
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error("Error generating Excel file:", error);
    res
      .status(500)
      .json({ error: "Error generating Excel file", details: error.message });
  }
};
const uploadCourierCodRemittance = async (req, res) => {
  try {
    const userID = req.user._id;

    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    // Save file metadata
    const fileData = new File({
      filename: req.file.filename,
      date: new Date(),
      status: "Processing",
    });
    await fileData.save();

    const fileExtension = path.extname(req.file.originalname).toLowerCase();
    let codRemittances = [];

    // Parse file
    if (fileExtension === ".csv") {
      codRemittances = await parseCSV(req.file.path, fileData);
    } else if ([".xlsx", ".xls"].includes(fileExtension)) {
      codRemittances = await parseExcel(req.file.path);
    } else {
      return res.status(400).json({ error: "Unsupported file format" });
    }

    if (!codRemittances?.length) {
      return res.status(400).json({
        error: "The uploaded file is empty or contains invalid data",
      });
    }

    // Fetch user's remittance once
    let userRemittance = await CourierCodRemittance.findOne({ userId: userID });
    if (!userRemittance) {
      return res
        .status(404)
        .json({ error: "User remittance record not found" });
    }

    let updated = false;

    // Normalize keys for matching
    const normalize = (val) => (val ? val.toString().trim() : "");

    for (const row of codRemittances) {
      const awbNumber = normalize(row["*AWB Number"] || row["AWBNumber"]);
      const codAmount = parseFloat(row["*COD Amount"] || row["CODAmount"]) || 0;

      const orderIndex = userRemittance.CourierCodRemittanceData.findIndex(
        (data) => normalize(data.AwbNumber) === awbNumber
      );

      if (
        orderIndex !== -1 &&
        userRemittance.CourierCodRemittanceData[orderIndex].status === "Pending"
      ) {
        userRemittance.CourierCodRemittanceData[orderIndex].status = "Paid";
        userRemittance.TransferredRemittance =
          (userRemittance.TransferredRemittance || 0) + codAmount;
        userRemittance.TotalRemittanceDue =
          (userRemittance.TotalRemittanceDue || 0) - codAmount;

        updated = true;
      }
    }

    if (updated) {
      await userRemittance.save();
    }

    // Delete file after DB update
    fs.unlink(req.file.path, (err) => {
      if (err) console.error("Error deleting file:", err);
      else console.log("File deleted successfully:", req.file.path);
    });

    return res.status(200).json({
      message: "Courier COD uploaded successfully",
      file: fileData,
    });
  } catch (error) {
    console.error("Error in uploadCourierCodRemittance:", error);
    res
      .status(500)
      .json({ error: "An error occurred while processing the file" });
  }
};

const exportOrderInRemittance = async (req, res) => {
  try {
    const userID = req.user._id;
    const ids = req.query.ids; // should be an array: ['REMID123', 'REMID456']

    if (!ids || !Array.isArray(ids)) {
      return res
        .status(400)
        .json({ message: "Remittance IDs must be an array." });
    }

    // Fetch remittance records
    const remittances = await adminCodRemittance
      .find({
        remitanceId: { $in: ids },
      })
      .populate("orderDetails");

    // Flatten all order ObjectIds from each remittance's `orders` array
    const allOrders = remittances.flatMap((remit) => remit.orderDetails);
    const orderIds = allOrders.flatMap((i) => i.orders);
    // Optional: Populate actual order data
    const rawOrders = await Order.find(
      { _id: { $in: orderIds } },
      {
        orderId: 1,
        courierServiceName: 1,
        awb_number: 1,
        "paymentDetails.method": 1,
        "paymentDetails.amount": 1,
        tracking: 1, // Include tracking to extract delivery date
      }
    );

    // Extract only needed info and delivery date from tracking
    const orderDetails = rawOrders.map((order) => {
      const deliveryEvent = order.tracking.find(
        (event) => event.status?.toLowerCase() === "delivered"
      );

      return {
        orderId: order.orderId,
        courierServiceName: order.courierServiceName,
        awb_number: order.awb_number,
        paymentMethod: order.paymentDetails?.method,
        paymentAmount: order.paymentDetails?.amount,
        deliveryDate: deliveryEvent?.StatusDateTime
          ? new Date(deliveryEvent.StatusDateTime).toLocaleDateString("en-US", {
              weekday: "long",
              year: "numeric",
              month: "long",
              day: "numeric",
            })
          : null,
      };
    });

    res.json({
      success: true,
      totalOrders: orderDetails.length,
      orders: orderDetails,
    });
  } catch (error) {
    console.error("Error exporting remittance orders:", error);
    res
      .status(500)
      .json({ message: "Server error while exporting remittance orders" });
  }
};

const validateCODTransfer = async (req, res) => {
  try {
    const remittanceIds = req.body.remittanceIds;
    console.log("Validating remittance IDs:", remittanceIds);
    if (!Array.isArray(remittanceIds) || remittanceIds.length === 0) {
      return res.status(400).json({ message: "Remittance IDs are required." });
    }

    // Step 1: Take the first remittanceId
    const firstRemittanceId = remittanceIds[0];
    // console.log("First remittance ID for user check:", firstRemittanceId);

    // Step 2: Find remittance by first ID
    const firstRemittance = await adminCodRemittance
      .findOne({ remitanceId: firstRemittanceId })
      .lean();

    if (!firstRemittance) {
      return res.status(404).json({ message: "First remittance not found." });
    }
    // console.log("First remittance found:", firstRemittance);

    const userId = firstRemittance.userId;

    // Step 3: Get all pending remittances for that user
    const pendingRemittances = await adminCodRemittance
      .find({ userId: userId, status: "Pending" })
      .lean();

    const pendingIds = pendingRemittances.map((r) => r.remitanceId);
    console.log("Pending remittance IDs for user:", pendingIds);
    // Step 4: Compare arrays strictly (both must match exactly)
    const sortArray = (arr) => arr.map(String).sort(); // ensure same type & sorted
    const reqSorted = sortArray(remittanceIds);
    const pendingSorted = sortArray(pendingIds);

    const isExactMatch =
      reqSorted.length === pendingSorted.length &&
      reqSorted.every((id, idx) => id === pendingSorted[idx]);

    if (!isExactMatch) {
      return res.status(400).json({
        message: "Please select all the pending remittance for same user",
        requiredPendingIds: pendingIds,
        providedIds: remittanceIds,
      });
    }

    // ✅ If exact match
    return res.status(200).json({
      message: "Validation successful",
      userId,
      remittanceIds,
    });
  } catch (error) {
    console.error("Error in validateCODTransfer:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

const getCODTransferData = async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({ message: "User ID is required." });
    }

    // 1. Fetch all remittance records for this user
    const remittanceRecords = await codRemittance.find({ userId: id }).lean();

    if (!remittanceRecords || remittanceRecords.length === 0) {
      return res
        .status(404)
        .json({ message: "No remittance data found for this user." });
    }

    // 2. Extract only pending remittanceData
    const pendingRemittances = remittanceRecords
      .map((record) => ({
        ...record,
        remittanceData: record.remittanceData.filter(
          (r) => r.status === "Pending"
        ),
      }))
      .filter((record) => record.remittanceData.length > 0);

    if (pendingRemittances.length === 0) {
      return res
        .status(404)
        .json({ message: "No pending remittance data found for this user." });
    }

    // 3. Fetch bank details for this user
    const bankDetails = await bankAccount.findOne({ user: id }).lean();

    if (!bankDetails) {
      return res
        .status(404)
        .json({ message: "Bank details not found for this user." });
    }

    // 4. Send response
    return res.status(200).json({
      message: "Pending remittance data & bank details fetched successfully",
      bankDetails,
      data: pendingRemittances,
    });
  } catch (error) {
    console.error("Error in getCODTransferData:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

const transferCOD = async (req, res) => {
  try {
    const { id } = req.params; // userId
    const { utr } = req.body;

    if (!id || !utr) {
      return res.status(400).json({ message: "User ID and UTR are required." });
    }

    // 1. Fetch COD Remittance record for this user
    const remittanceRecord = await codRemittance.findOne({ userId: id });
    if (!remittanceRecord) {
      return res
        .status(404)
        .json({ message: "No remittance data found for this user." });
    }

    // 2. Find all Pending remittanceData
    const pendingRemittances = remittanceRecord.remittanceData.filter(
      (r) => r.status === "Pending"
    );

    if (pendingRemittances.length === 0) {
      return res
        .status(400)
        .json({ message: "No pending remittance data found for this user." });
    }

    // 3. Remove duplicate remittanceIds
    const uniquePendingRemittances = [];
    const seenIds = new Set();

    for (let r of pendingRemittances) {
      if (!seenIds.has(r.remittanceId)) {
        seenIds.add(r.remittanceId);
        uniquePendingRemittances.push(r);
      }
    }

    // 4. Calculate total sum of COD available (only unique ones)
    const initiatedSum = uniquePendingRemittances.reduce(
      (sum, r) => sum + (r.codAvailable || 0),
      0
    );

    // 5. Update remittanceData -> set Paid + utr
    remittanceRecord.remittanceData = remittanceRecord.remittanceData.map((r) =>
      r.status === "Pending" && seenIds.has(r.remittanceId)
        ? { ...r, status: "Paid", utr, remittanceMethod: "Bank Transaction" }
        : r
    );

    // 6. Update summary fields in codRemittance
    remittanceRecord.LastCODRemitted = initiatedSum;
    remittanceRecord.RemittanceInitiated =
      (remittanceRecord.RemittanceInitiated || 0) - initiatedSum;
    remittanceRecord.TotalCODRemitted =
      (Number(remittanceRecord.TotalCODRemitted) || 0) + initiatedSum;

    await remittanceRecord.save();

    // 7. Update adminCodRemittance for each unique remittanceId
    for (let rem of uniquePendingRemittances) {
      await adminCodRemittance.findOneAndUpdate(
        { remitanceId: rem.remittanceId },
        { $set: { status: "Paid" } }
      );
    }

    return res.status(200).json({
      message: "COD transfer completed successfully",
      utr,
      remittanceInitiated: initiatedSum,
      data: remittanceRecord,
    });
  } catch (error) {
    console.error("Error in transferCOD:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

module.exports = {
  codPlanUpdate,
  codToBeRemitteds,
  codRemittanceData,
  getCodRemitance,
  codRemittanceRecharge,
  getAdminCodRemitanceData,
  downloadSampleExcel,
  uploadCodRemittance,
  CheckCodplan,
  remittanceTransactionData,
  courierCodRemittance,
  CodRemittanceOrder,
  sellerremittanceTransactionData,
  CourierdownloadSampleExcel,
  uploadCourierCodRemittance,
  exportOrderInRemittance,
  validateCODTransfer,
  getCODTransferData,
  transferCOD,
};
