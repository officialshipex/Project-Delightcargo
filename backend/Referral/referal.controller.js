const mongoose = require("mongoose");
const dayjs = require("dayjs");
const User = require("../models/User.model.js");
const Order = require("../models/newOrder.model.js");
const ReferralMonthlyStat = require("./referal.model.js");
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

  try {
    const ref = dayjs(referenceDate);
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
    }).lean();

    for (const user of parentUsers) {
      const subUserIds = (user.subUserId || []).map((id) =>
        mongoose.Types.ObjectId(id)
      );
      if (!subUserIds.length) continue;

      // Fetch all "Delivered" orders for sub-users within this month
      const orders = await Order.find({
        userId: { $in: subUserIds },
        status: "Delivered",
        "tracking.StatusDateTime": { $exists: true },
      }).lean();

      // Filter by tracking last date
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

      // Prevent duplication by checking previous recorded orderIds
      const existingOrderIds = await ReferralMonthlyStat.find({
        userId: user.userId, // use userId instead of _id
        "perSubUser.orderIds": { $exists: true, $ne: [] },
      }).distinct("perSubUser.orderIds");

      const uniqueOrders = deliveredOrders.filter(
        (ord) => !existingOrderIds.includes(ord._id.toString())
      );

      if (!uniqueOrders.length) {
        console.log(`⚠️ All orders for user ${user._id} already counted.`);
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
      }

      // Get sub-user details (name, email, mobile)
      const subUsers = await User.find({ _id: { $in: subUserIds } })
        .select("name email mobile userId")
        .lean();

      const commissionRate = Number(user.commission || 2);
      const totalCommission = (totalShipping * commissionRate) / 100;

      // Construct perSubUser array with additional info and date range
      const perSubUser = [];
      for (const [subId, val] of subUserMap.entries()) {
        const subUser = subUsers.find((su) => su._id.toString() === subId);
        const commissionForSub = (val.totalShipping * commissionRate) / 100;

        perSubUser.push({
          subUserId: subId,
          userId:subUser?.userId,
          name: subUser?.name || "N/A",
          email: subUser?.email || "N/A",
          mobile: subUser?.mobile || "N/A",
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
        month: ref.month() + 1,
        year: ref.year(),
        userId: user._id,
        referralCount: user.subUserId?.length || 0,
        totalOrderCount: uniqueOrders.length,
        totalShipping,
        totalCommission,
        perSubUser,
      });

      await statDoc.save();
      console.log(
        `✅ Saved referral stat for user ${user.userId} (${
          uniqueOrders.length
        } orders, ₹${totalShipping.toFixed(2)})`
      );
    }

    return { success: true, message: "Referral monthly reports generated." };
  } catch (err) {
    console.error("❌ Error generating monthly referral report:", err);
    return { success: false, message: err.message || "Error" };
  } finally {
    session.endSession();
  }
};

cron.schedule("59 23 * * *", async () => {
  const now = dayjs();
  const tomorrow = now.add(1, "day");

  // if tomorrow's month is different -> today is last day
  if (tomorrow.month() !== now.month()) {
    console.log(
      "Today is last day of month. Generating monthly referral report..."
    );
    try {
      //   await generateMonthlyReferralReport(now.toDate());
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
    const userId = req.user._id; // assuming middleware adds req.user
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ message: "Invalid user ID" });
    }

    // Fetch all monthly stats for this user, sorted by month descending
    const monthlyStats = await ReferralMonthlyStat.find({ userId })
      .sort({ year: -1, month: -1 })
      .lean();

    // Aggregate totals
    const stats = {
      referredFriends: 0,
      referralOrders: 0,
      totalShipping: 0,
      totalCommission: 0,
      withdrawn: 0, // add if you track withdrawals separately
      remaining: 0, // add if you track remaining commission separately
    };

    monthlyStats.forEach((month) => {
      stats.referralOrders += month.totalOrderCount || 0;
      stats.totalShipping += month.totalShipping || 0;
      stats.totalCommission += month.totalCommission || 0;
    });

    // Calculate referredFriends count (from User collection)
    const parentUser = await User.findById(userId).lean();
    stats.referredFriends = (parentUser?.subUserId || []).length;

    // Prepare monthlyData array for frontend
    const monthlyData = monthlyStats.map((month) => ({
      month: `${month.month}-${month.year}`,
      referralOrders: month.totalOrderCount,
      shippingCharges: month.totalShipping,
      commission: month.totalCommission,
      fromDate: month.fromDate,
      toDate: month.toDate,
      date: month.createdAt || new Date(), // fallback to creation date
    }));

    return res.status(200).json({ stats, monthlyData });
  } catch (err) {
    console.error("Error fetching referral stats:", err);
    return res.status(500).json({ message: "Failed to fetch referral stats" });
  }
};

const getAllReferralStats = async (req, res) => {
  try {
    const { month, year, referById, subUserId } = req.query;

    // Fetch all monthly referral stats
    let query = {};
    if (month) query.month = parseInt(month);
    if (year) query.year = parseInt(year);
    if (referById) query.userId = referById;
    if (subUserId) query.subUserId = subUserId;

    const referrals = await ReferralMonthlyStat.find(query)
      .sort({ year: -1, month: -1 })
      .lean();

    // Prepare summary
    const summary = {
      totalUsers: 0,
      totalOrders: 0,
      totalShipping: 0,
      totalCommission: 0,
    };

    const userIdsSet = new Set();

    referrals.forEach((r) => {
      summary.totalOrders += r.totalOrderCount || 0;
      summary.totalShipping += r.totalShipping || 0;
      summary.totalCommission += r.totalCommission || 0;
      if (r.userId) userIdsSet.add(r.userId.toString());
    });

    summary.totalUsers = userIdsSet.size;

    // Optionally populate user/subuser details
    const userIds = Array.from(userIdsSet);
    const users = await User.find({ _id: { $in: userIds } })
      .select("_id fullname email phoneNumber")
      .lean();

    // Map user info into referrals
    const enrichedReferrals = referrals.map((r) => {
      const user = users.find((u) => u._id.toString() === r.userId?.toString());
      return {
        ...r,
        userName: user?.fullname || "-",
        email: user?.email || "-",
        mobile: user?.phoneNumber || "-",
      };
    });

    return res.status(200).json({
      referrals: enrichedReferrals,
      summary,
    });
  } catch (err) {
    console.error("Error fetching admin referral stats:", err);
    return res.status(500).json({ message: "Failed to fetch referral stats" });
  }
};

module.exports = { generateMonthlyReferralReport, getReferralStats,getAllReferralStats };
