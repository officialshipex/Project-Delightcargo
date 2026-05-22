const mongoose = require("mongoose");
const dayjs = require("dayjs");
const User = require("../models/User.model.js");
const Order = require("../models/newOrder.model.js");
const ReferralMonthlyStat = require("./referal.model.js");
const ReferralWithdrawal = require("./referalWithdrawal.model.js");
const Wallet = require("../models/wallet");
const WalletTransaction = require("../models/WalletTransaction.model");
const cron = require("node-cron");
/**
 * Generate monthly referral reports for all users that have subUserId populated.
 * This function computes delivered orders in the target month, sums freight charges,
 * computes commission and saves a report document.
 *
 * @param {Date} [referenceDate=new Date()] - A date inside the month to process. If omitted, uses now().
 */

// console.log("Referral controller loaded");
const generateMonthlyReferralReport = async (referenceDate = new Date()) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const ref = dayjs(referenceDate);
    const month = ref.month() + 1;
    const year = ref.year();
    const fromDate = ref.startOf("month").toDate();
    const toDate = ref.endOf("month").toDate();

    console.log(
      `🧾 Generating referral report for ${ref.format(
        "MMMM YYYY"
      )}: ${fromDate.toISOString()} → ${toDate.toISOString()}`
    );

    // Fetch all parent users who have referred sub-users
    const parentUsers = await User.find({
      subUserId: { $exists: true, $ne: [], $not: { $size: 0 } },
    }).session(session).lean();

    // ─── STAGE 1: GLOBAL DEDUPLICATION PREP ──────────────────────────────────
    // Fetch ALL orderIds that have ever been included in ANY referral report
    // This is the strongest security check to prevent double-counting.
    const allCommissionedOrders = await ReferralMonthlyStat.aggregate([
      { $unwind: "$perSubUser" },
      { $unwind: "$perSubUser.orderIds" },
      { $group: { _id: null, orderIds: { $addToSet: "$perSubUser.orderIds" } } }
    ]).session(session);

    const commissionedSet = new Set(
      allCommissionedOrders.length > 0
        ? allCommissionedOrders[0].orderIds.map(id => id.toString())
        : []
    );

    for (const user of parentUsers) {
      // 1. Security Check: Skip if report already exists for this specific month/year/user
      const existingReport = await ReferralMonthlyStat.findOne({
        month,
        year,
        userId: user._id
      }).session(session);

      if (existingReport) {
        console.log(`⚠️ Report for user ${user.userId} already exists for ${month}/${year}. Skipping.`);
        continue;
      }

      const subUserIds = (user.subUserId || []).map(
        (id) => new mongoose.Types.ObjectId(id)
      );

      if (!subUserIds.length) continue;

      // Fetch all "Delivered" orders for sub-users within this month
      const orders = await Order.find({
        userId: { $in: subUserIds },
        status: "Delivered",
        "tracking.StatusDateTime": { $exists: true },
      }).session(session).lean();

      // Filter by tracking last date manually
      const deliveredOrders = orders.filter((ord) => {
        const lastTracking = ord.tracking?.[ord.tracking.length - 1];
        if (!lastTracking?.StatusDateTime) return false;
        const statusDate = new Date(lastTracking.StatusDateTime);
        return statusDate >= fromDate && statusDate <= toDate;
      });

      if (!deliveredOrders.length) {
        console.log(`❌ No delivered orders for user ${user._id} this month.`);
        continue;
      }

      // 2. Security Check: Filter orders that are both in the date range AND haven't been processed yet
      const uniqueOrders = deliveredOrders.filter(
        (ord) => !commissionedSet.has(ord._id.toString())
      );

      if (!uniqueOrders.length) {
        console.log(`⚠️ All potential orders for user ${user._id} were already counted in previous runs.`);
        continue;
      }

      // Build map per sub-user
      const subUserMap = new Map();
      let totalShipping = 0;

      for (const ord of uniqueOrders) {
        const subId = ord.userId.toString();
        const freight = Number(ord.totalFreightCharges || 0);
        totalShipping += freight;

        if (!subUserMap.has(subId)) {
          subUserMap.set(subId, {
            subUserId: subId,
            orderCount: 0,
            totalShipping: 0,
            orderIds: [],
          });
        }

        const entry = subUserMap.get(subId);
        entry.orderCount += 1;
        entry.totalShipping += freight;
        entry.orderIds.push(ord._id);
        subUserMap.set(subId, entry);

        // Mark as locally processed so we don't accidentally count it again if logic shifts
        commissionedSet.add(ord._id.toString());
      }

      // Get sub-user details (name, email, mobile)
      const subUsers = await User.find({ _id: { $in: subUserIds } })
        .select("name email phoneNumber userId") // use phoneNumber if that's the field name
        .session(session)
        .lean();

      const commissionRate = Number(user.commission || 2);
      const totalCommission = Number(
        ((totalShipping * commissionRate) / 100).toFixed(2)
      );

      const perSubUser = [];
      for (const [subId, val] of subUserMap.entries()) {
        const subUser = subUsers.find((su) => su._id.toString() === subId);
        const commissionForSub = Number(
          ((val.totalShipping * commissionRate) / 100).toFixed(2)
        );

        perSubUser.push({
          subUserId: subId,
          userId: subUser?.userId,
          name: subUser?.fullname || "N/A",
          email: subUser?.email || "N/A",
          mobile: subUser?.phoneNumber || "N/A", // matches mobile logic in other views
          fromDate,
          toDate,
          orderCount: val.orderCount,
          totalShipping: val.totalShipping,
          commission: commissionForSub,
          orderIds: val.orderIds,
        });
      }

      // Save final monthly stats
      const statDoc = new ReferralMonthlyStat({
        month,
        year,
        userId: user._id,
        totalOrderCount: uniqueOrders.length,
        totalShipping,
        totalCommission,
        perSubUser,
      });

      await statDoc.save({ session });
      console.log(
        `✅ Saved referral stat for user ${user.userId} (${uniqueOrders.length
        } orders, ₹${totalShipping.toFixed(2)})`
      );
    }

    await session.commitTransaction();
    return { success: true, message: "Referral monthly reports generated." };
  } catch (err) {
    await session.abortTransaction();
    console.error("❌ Error generating monthly referral report:", err);
    return { success: false, message: err.message || "Error" };
  } finally {
    session.endSession();
  }
};
// generateMonthlyReferralReport()

cron.schedule("59 23 * * *", async () => {
  const now = dayjs();
  const tomorrow = now.add(1, "day");

  // if tomorrow's month is different -> today is last day
  if (tomorrow.month() !== now.month()) {
    console.log(
      "Today is last day of month. Generating monthly referral report..."
    );
    try {
      await generateMonthlyReferralReport(now.toDate());
      console.log("Referral monthly report job completed.");
    } catch (err) {
      console.error("Referral monthly report job failed:", err);
    }
  } else {
    console.log("Not last day of month. Skipping referral job.");
  }
});

const getReferralStats = async (req, res) => {
  try {
    let userId = req.user._id;

    if (req.user.isAdmin && req.query.targetUserId) {
      userId = req.query.targetUserId;
    }

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ message: "Invalid user ID" });
    }

    // Extract filters
    const { month, year } = req.query;

    // Pagination
    const pageNum = parseInt(req.query.page) || 1;
    const limitNum = parseInt(req.query.limit) || 20;

    // Build filter query for ALL matching records to get totals
    const allRecordsQuery = { userId };
    if (month && year) {
      allRecordsQuery.month = Number(month);
      allRecordsQuery.year = Number(year);
    }

    const allMatchingStats = await ReferralMonthlyStat.find(allRecordsQuery).lean();

    // Fetch paginated monthly stats
    const monthlyStats = await ReferralMonthlyStat.find(allRecordsQuery)
      .sort({ year: -1, month: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean();

    const totalRecords = await ReferralMonthlyStat.countDocuments(allRecordsQuery);

    // Initialize totals
    const stats = {
      referredFriends: 0,
      referralOrders: 0,
      totalShipping: 0,
      totalCommission: 0,
      withdrawn: 0,
      remaining: 0,
    };

    // Calculate totals from ALL matching records
    allMatchingStats.forEach((month) => {
      stats.referralOrders += month.totalOrderCount || 0;
      stats.totalShipping += month.totalShipping || 0;
      stats.totalCommission += month.totalCommission || 0;
    });

    // Fetch referred friends count
    const parentUser = await User.findById(
      userId,
      "subUserId referralCommissionPercentage"
    ).lean();
    stats.referredFriends = parentUser?.subUserId?.length || 0;

    // Calculate total withdrawn
    const withdrawals = await ReferralWithdrawal.find({ userId }).lean();
    stats.withdrawn = withdrawals.reduce((sum, w) => sum + (w.amount || 0), 0);
    stats.remaining = Math.max(0, stats.totalCommission - stats.withdrawn);

    // Prepare data for frontend
    const monthlyData = monthlyStats.map((month) => ({
      month: `${dayjs()
        .month(month.month - 1)
        .format("MMMM")} ${month.year}`,
      referralOrders: month.totalOrderCount || 0,
      shippingCharges: month.totalShipping || 0,
      commission: month.totalCommission || 0,
      fromDate: month.fromDate,
      toDate: month.toDate,
      date: month.createdAt || new Date(),
    }));

    return res.status(200).json({
      stats,
      monthlyData,
      total: totalRecords,
      totalPages: Math.ceil(totalRecords / limitNum),
      referralCommissionPercentage:
        parentUser?.referralCommissionPercentage || 0,
    });
  } catch (err) {
    console.error("❌ Error fetching referral stats:", err);
    return res.status(500).json({ message: "Failed to fetch referral stats" });
  }
};

const getAllReferralStats = async (req, res) => {
  try {
    const { month, year, referById, page, limit } = req.query;
    console.log("req.query", req.query);

    const query = {};
    if (month) query.month = parseInt(month);
    if (year) query.year = parseInt(year);

    if (referById) {
      // ✅ Try both string and ObjectId match for compatibility
      query.$or = [
        { userId: referById },
        { userId: new mongoose.Types.ObjectId(referById) },
      ];
    }

    // Pagination
    const pageNum = parseInt(page) || 1;
    const limitNum = parseInt(limit) || 20;

    // Get all matching referrals for summary calculation
    const allReferrals = await ReferralMonthlyStat.find(query).lean();

    // Get paginated referrals
    const referrals = await ReferralMonthlyStat.find(query)
      .sort({ year: -1, month: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean();

    const totalRecords = await ReferralMonthlyStat.countDocuments(query);

    console.log("Referral Count Found:", referrals.length);

    const summary = {
      totalUsers: 0,
      totalOrders: 0,
      totalShipping: 0,
      totalCommission: 0,
    };

    // Calculate summary from ALL matching referrals
    allReferrals.forEach((r) => {
      summary.totalOrders += r.totalOrderCount || 0;
      summary.totalShipping += r.totalShipping || 0;
      summary.totalCommission += r.totalCommission || 0;
    });

    const userFilter = referById
      ? {
        $or: [
          { _id: new mongoose.Types.ObjectId(referById) },
          { _id: referById },
        ],
      }
      : { subUserId: { $exists: true, $ne: [] } };

    const users = await User.find(
      userFilter,
      "_id fullname email phoneNumber userId subUserId"
    ).lean();

    const allSubUserIds = users.flatMap((u) => u.subUserId || []);

    const subUsers = await User.find(
      { _id: { $in: allSubUserIds } },
      "_id fullname email phoneNumber userId"
    ).lean();

    summary.totalUsers = users.reduce(
      (sum, u) => sum + (Array.isArray(u.subUserId) ? u.subUserId.length : 0),
      0
    );

    const enrichedReferrals = referrals.map((r) => {
      const user = users.find(
        (u) =>
          u._id.toString() === r.userId?.toString() ||
          u._id.toString() === r.userId
      );

      const referredFriendsCount = user?.subUserId?.length || 0;

      const subUsersData = (r.perSubUser || []).map((su) => {
        const subUserInfo = subUsers.find(
          (sub) => sub._id.toString() === su.subUserId?.toString()
        );

        return {
          userId: subUserInfo?.userId || "-",
          fullname: subUserInfo?.fullname || "-",
          email: subUserInfo?.email || "-",
          mobile: subUserInfo?.phoneNumber || "-",
          orderCount: su.orderCount || 0,
          totalShipping: su.totalShipping || 0,
          commission: su.commission || 0,
        };
      });

      return {
        ...r,
        userId: user?.userId || "-",
        userIdMongo: user?._id, // Internal ID for wallet transfers
        userName: user?.fullname || "-",
        email: user?.email || "-",
        mobile: user?.phoneNumber || "-",
        referredFriends: referredFriendsCount,
        subUsers: subUsersData,
      };
    });

    return res.status(200).json({
      referrals: enrichedReferrals,
      summary,
      total: totalRecords,
      totalPages: Math.ceil(totalRecords / limitNum),
    });

  } catch (err) {
    console.error("Error fetching admin referral stats:", err);
    return res.status(500).json({ message: "Failed to fetch referral stats" });
  }
};

const updateAllReferralCommission = async () => {
  try {
    const result = await User.updateMany(
      {}, // match all users
      { referralCommissionPercentage: 2 } // update value
    );

    console.log("Referral Commission Updated for all users:", result);
  } catch (error) {
    console.error("Error updating referral commission for all users:", error);
  }
};
// updateAllReferralCommission()

// =========================================================================
// MANUAL TRIGGER FOR TESTING
// To run the report for the PREVIOUS month manually, uncomment the line below 
// and save the file. Remember to comment it back once the report is generated!
// -------------------------------------------------------------------------
// generateMonthlyReferralReport(dayjs().subtract(1, "month").toDate());
// =========================================================================

const withdrawCommission = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    let userId = req.user._id;
    const { amount, targetUserId } = req.body;

    // Admin Override: If user is admin and targetUserId is provided, use that instead
    if (req.user.isAdmin && targetUserId) {
      if (!mongoose.Types.ObjectId.isValid(targetUserId)) {
        return res.status(400).json({ message: "Invalid target user ID" });
      }
      userId = targetUserId;
    }

    if (!amount || amount <= 0) {
      return res.status(400).json({ message: "Invalid withdrawal amount" });
    }

    // 1. Calculate available balance
    const allStats = await ReferralMonthlyStat.find({ userId }).session(session).lean();
    const totalCommission = allStats.reduce((sum, m) => sum + (m.totalCommission || 0), 0);

    const withdrawals = await ReferralWithdrawal.find({ userId }).session(session).lean();
    const totalWithdrawn = withdrawals.reduce((sum, w) => sum + (w.amount || 0), 0);

    const remaining = totalCommission - totalWithdrawn;

    if (amount > remaining) {
      return res.status(400).json({ message: "Insufficient referral commission balance" });
    }

    // 2. Find User and Wallet
    const user = await User.findById(userId).session(session);
    if (!user || !user.Wallet) {
      return res.status(404).json({ message: "User or Wallet not found" });
    }

    const wallet = await Wallet.findById(user.Wallet).select("balance").session(session);
    if (!wallet) {
      return res.status(404).json({ message: "Wallet not found" });
    }

    // 3. Update Wallet Balance and add transaction
    const newBalance = wallet.balance + amount;
    await WalletTransaction.create([{
      walletId: wallet._id,
      category: "credit",
      amount,
      balanceAfterTransaction: newBalance,
      description: "Referral Commission Received",
    }], { session });
    wallet.balance = newBalance;
    await wallet.save({ session });

    // 4. Record the Withdrawal
    const withdrawalDoc = new ReferralWithdrawal({
      userId,
      amount,
      status: "Success",
      description: "Transferred to Wallet",
    });
    await withdrawalDoc.save({ session });

    await session.commitTransaction();
    return res.status(200).json({
      success: true,
      message: `₹${amount.toFixed(2)} transferred to your wallet successfully!`,
      updatedBalance: newBalance
    });
  } catch (err) {
    await session.abortTransaction();
    console.error("❌ Error withdrawing commission:", err);
    return res.status(500).json({ message: "Internal server error during withdrawal" });
  } finally {
    session.endSession();
  }
};

module.exports = {
  generateMonthlyReferralReport,
  getReferralStats,
  getAllReferralStats,
  withdrawCommission,
};
