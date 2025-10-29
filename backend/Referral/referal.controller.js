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
      const subUserIds = (user.subUserId || []).map(
        (id) => new mongoose.Types.ObjectId(id)
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
        userId: user._id, // use userId instead of _id
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
      const totalCommission = Number(
        ((totalShipping * commissionRate) / 100).toFixed(2)
      );

      // Construct perSubUser array with additional info and date range
      const perSubUser = [];
      for (const [subId, val] of subUserMap.entries()) {
        const subUser = subUsers.find((su) => su._id.toString() === subId);
        const commissionForSub = Number(
          ((val.totalShipping * commissionRate) / 100).toFixed(2)
        );

        perSubUser.push({
          subUserId: subId,
          userId: subUser?.userId,
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
    const userId = req.user._id; // added by auth middleware
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ message: "Invalid user ID" });
    }

    // Extract filters
    const { month, year } = req.query;

    // Build filter query
    const query = { userId };
    if (month && year) {
      query.month = Number(month);
      query.year = Number(year);
    }

    // Fetch monthly stats
    const monthlyStats = await ReferralMonthlyStat.find(query)
      .sort({ year: -1, month: -1 })
      .lean();

    // Initialize totals
    const stats = {
      referredFriends: 0,
      referralOrders: 0,
      totalShipping: 0,
      totalCommission: 0,
      withdrawn: 0,
      remaining: 0,
    };

    // Calculate totals from monthly records
    monthlyStats.forEach((month) => {
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
    // console.log("Parent user:", parentUser);
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
    const { month, year, referById } = req.query;
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

    const referrals = await ReferralMonthlyStat.find(query)
      .sort({ year: -1, month: -1 })
      .lean();

    console.log("Referral Count Found:", referrals.length);

    const summary = {
      totalUsers: 0,
      totalOrders: 0,
      totalShipping: 0,
      totalCommission: 0,
    };

    referrals.forEach((r) => {
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
    });
  } catch (err) {
    console.error("Error fetching admin referral stats:", err);
    return res.status(500).json({ message: "Failed to fetch referral stats" });
  }
};

module.exports = {
  generateMonthlyReferralReport,
  getReferralStats,
  getAllReferralStats,
};
