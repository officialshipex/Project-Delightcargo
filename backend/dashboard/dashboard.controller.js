const Order = require("../models/newOrder.model");
const { getZone } = require("../Rate/zoneManagementController");
const Cod = require("../COD/codRemittance.model");
const moment = require("moment");
const User = require("../models/User.model");
const mongoose = require("mongoose");
const WeightDispute = require("../WeightDispreancy/weightDispreancy.model");

const dashboard = async (req, res) => {
  try {
    const userId = req.user._id;
    // Fetch all shipping orders to determine zones

    // Dates
    const now = new Date();
    const startOfMonth = moment().startOf("month").toDate();
    const startOfWeek = moment().startOf("week").toDate();
    const startOfQuarter = moment().startOf("quarter").toDate();
    const last90Days = moment().subtract(90, "days").toDate();

    const [result] = await Order.aggregate([
      { $match: { userId } },
      {
        $facet: {
          ordersByZone: [
            {
              $group: {
                _id: "$zone",
                count: { $sum: 1 },
              },
            },
            {
              $project: {
                zone: "$_id",
                count: 1,
                _id: 0,
              },
            },
          ],

          totalOrders: [{ $count: "count" }],
          deliveredStats: [
            { $match: { status: "Delivered" } },
            {
              $group: {
                _id: null,
                deliveredCount: { $sum: 1 },
                totalRevenue: { $sum: "$paymentDetails.amount" },
              },
            },
          ],
          shippingStats: [
            {
              $match: {
                status: {
                  $in: [
                    "Delivered",
                    "In-transit",
                    "Ready To Ship",
                    "Undelivered",
                    "RTO",
                    "RTO In-transit",
                    "Out for Delivery",
                    "RTO Delivered",
                  ],
                },
              },
            },
            {
              $group: {
                _id: null,
                shippingCount: { $sum: 1 },
                totalFreight: { $sum: "$totalFreightCharges" },
              },
            },
          ],
          pendingOrders: [{ $match: { status: "new" } }, { $count: "count" }],
          inTransitOrders: [
            { $match: { status: "In-transit" } },
            { $count: "count" },
          ],
          readyToShipOrders: [
            { $match: { status: "Ready To Ship" } },
            { $count: "count" },
          ],
          RTOOrders: [
            { $match: { status: "RTO Delivered" } },
            { $count: "count" },
          ],
          ndrOrders: [
            { $match: { ndrStatus: "Undelivered" } },
            { $count: "count" },
          ],
          actionRequestedOrders: [
            { $match: { ndrStatus: "Action_Requested" } },
            { $count: "count" },
          ],
          ndrDeliveredOrders: [
            {
              $match: {
                ndrStatus: "Delivered",
                $expr: { $gt: [{ $size: "$ndrHistory" }, 1] },
              },
            },
            { $count: "count" },
          ],
          ordersByProvider: [
            { $match: { userId } },
            {
              $group: {
                _id: "$provider",
                count: { $sum: 1 },
              },
            },
            {
              $project: {
                provider: "$_id",
                count: 1,
                _id: 0,
              },
            },
          ],

          // 💰 Revenue Time Ranges
          last90DaysRevenue: [
            {
              $match: { status: "Delivered", createdAt: { $gte: last90Days } },
            },
            {
              $group: {
                _id: null,
                revenue: { $sum: "$paymentDetails.amount" },
              },
            },
          ],
          thisMonthRevenue: [
            {
              $match: {
                status: "Delivered",
                createdAt: { $gte: startOfMonth },
              },
            },
            {
              $group: {
                _id: null,
                revenue: { $sum: "$paymentDetails.amount" },
              },
            },
          ],
          thisWeekRevenue: [
            {
              $match: { status: "Delivered", createdAt: { $gte: startOfWeek } },
            },
            {
              $group: {
                _id: null,
                revenue: { $sum: "$paymentDetails.amount" },
              },
            },
          ],
          thisQuarterRevenue: [
            {
              $match: {
                status: "Delivered",
                createdAt: { $gte: startOfQuarter },
              },
            },
            {
              $group: {
                _id: null,
                revenue: { $sum: "$paymentDetails.amount" },
              },
            },
          ],
        },
      },
    ]);

    // Destructure safely
    const {
      totalOrders = [],
      deliveredStats = [],
      shippingStats = [],
      pendingOrders = [],
      inTransitOrders = [],
      readyToShipOrders = [],
      RTOOrders = [],
      ndrOrders = [],
      actionRequestedOrders = [],
      ndrDeliveredOrders = [],
      ordersByProvider = [],
      last90DaysRevenue = [],
      thisMonthRevenue = [],
      thisWeekRevenue = [],
      thisQuarterRevenue = [],
      ordersByZone = [],
    } = result || {};

    const totalOrderCount = totalOrders[0]?.count || 0;
    const deliveredCount = deliveredStats[0]?.deliveredCount || 0;
    const totalRevenue = deliveredStats[0]?.totalRevenue || 0;
    const shippingCount = shippingStats[0]?.shippingCount || 0;
    const totalFreight = shippingStats[0]?.totalFreight || 0;
    const averageShipping =
      shippingCount > 0 ? Math.round(totalFreight / shippingCount) : 0;

    const totalNdr =
      (ndrOrders[0]?.count || 0) +
      (actionRequestedOrders[0]?.count || 0) +
      (ndrDeliveredOrders[0]?.count || 0);
    // console.log("revneue",totalRevenue)

    const ordersByZoneWithPercentage = ordersByZone.map((zone) => {
      const percentage =
        totalOrderCount > 0
          ? ((zone.count / totalOrderCount) * 100).toFixed(2)
          : "0.00";
      return {
        ...zone,
        percentage: Number(percentage), // or keep as string with '%' suffix
      };
    });
    console.log("ndr", totalNdr);
    return res.status(200).json({
      success: true,
      data: {
        totalOrders: totalOrderCount,
        deliveredOrders: deliveredCount,
        totalRevenue,
        shippingCount,
        totalFreight,
        averageShipping,
        pendingOrders: pendingOrders[0]?.count || 0,
        inTransitOrders: inTransitOrders[0]?.count || 0,
        readyToShipOrders: readyToShipOrders[0]?.count || 0,
        RTOOrders: RTOOrders[0]?.count || 0,
        ndrOrders: ndrOrders[0]?.count || 0,
        actionRequestedOrders: actionRequestedOrders[0]?.count || 0,
        ndrDeliveredOrders: ndrDeliveredOrders[0]?.count || 0,
        totalNdr,
        ordersByProvider,
        revenueStats: {
          last90Days: last90DaysRevenue[0]?.revenue || 0,
          thisMonth: thisMonthRevenue[0]?.revenue || 0,
          thisWeek: thisWeekRevenue[0]?.revenue || 0,
          thisQuarter: thisQuarterRevenue[0]?.revenue || 0,
        },
        ordersByZone: ordersByZoneWithPercentage,
      },
    });
  } catch (error) {
    console.error("Dashboard Error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
};

const getBusinessInsights = async (req, res) => {
  try {
    let userId = req.user._id;
    let searchId = req.query.userId;

    const userData = await User.findById(userId);
    const isAdminView = userData?.isAdmin && userData?.adminTab;

    // Dates
    const startOfToday = moment().startOf("day").toDate();
    const last30Days = moment().subtract(30, "days").toDate();
    const prev30Days = moment().subtract(60, "days").toDate();
    const startOfWeek = moment().startOf("week").toDate();
    const startOfLastWeek = moment()
      .subtract(1, "weeks")
      .startOf("week")
      .toDate();
    const startOfMonth = moment().startOf("month").toDate();
    const startOfLastMonth = moment()
      .subtract(1, "months")
      .startOf("month")
      .toDate();
    const startOfQuarter = moment().startOf("quarter").toDate();
    const startOfLastQuarter = moment()
      .subtract(1, "quarters")
      .startOf("quarter")
      .toDate();

    let baseMatch = {};
    if (!isAdminView) {
      baseMatch.userId = userId;
    } else if (searchId) {
      baseMatch.userId = new mongoose.Types.ObjectId(searchId);
    }

    // Exclude unwanted statuses
    const validStatus = { $nin: ["new", "Cancelled"] };

    const [result] = await Order.aggregate([
      { $match: baseMatch },
      {
        $facet: {
          // === TODAY ===
          todaysOrders: [
            { $match: { createdAt: { $gte: startOfToday } } },
            { $count: "count" },
          ],
          todaysOrderValue: [
            {
              $match: {
                createdAt: { $gte: startOfToday },
                status: validStatus,
              },
            },
            {
              $group: {
                _id: null,
                orderValue: { $sum: "$paymentDetails.amount" },
              },
            },
          ],

          // === 30 DAYS ===
          last30DaysOrders: [
            { $match: { createdAt: { $gte: last30Days } } },
            { $count: "count" },
          ],
          last30DaysOrderValue: [
            {
              $match: {
                createdAt: { $gte: last30Days },
                status: validStatus,
              },
            },
            {
              $group: {
                _id: null,
                orderValue: { $sum: "$paymentDetails.amount" },
              },
            },
          ],
          prev30DaysOrders: [
            { $match: { createdAt: { $gte: prev30Days, $lt: last30Days } } },
            { $count: "count" },
          ],
          prev30DaysOrderValue: [
            {
              $match: {
                createdAt: { $gte: prev30Days, $lt: last30Days },
                status: validStatus,
              },
            },
            {
              $group: {
                _id: null,
                orderValue: { $sum: "$paymentDetails.amount" },
              },
            },
          ],

          // === WEEK ===
          weekOrders: [
            { $match: { createdAt: { $gte: startOfWeek } } },
            { $count: "count" },
          ],
          lastWeekOrders: [
            {
              $match: {
                createdAt: { $gte: startOfLastWeek, $lt: startOfWeek },
              },
            },
            { $count: "count" },
          ],
          weekOrderValue: [
            {
              $match: {
                createdAt: { $gte: startOfWeek },
                status: validStatus,
              },
            },
            {
              $group: {
                _id: null,
                orderValue: { $sum: "$paymentDetails.amount" },
              },
            },
          ],
          lastWeekOrderValue: [
            {
              $match: {
                createdAt: { $gte: startOfLastWeek, $lt: startOfWeek },
                status: validStatus,
              },
            },
            {
              $group: {
                _id: null,
                orderValue: { $sum: "$paymentDetails.amount" },
              },
            },
          ],

          // === MONTH ===
          monthOrders: [
            { $match: { createdAt: { $gte: startOfMonth } } },
            { $count: "count" },
          ],
          lastMonthOrders: [
            {
              $match: {
                createdAt: { $gte: startOfLastMonth, $lt: startOfMonth },
              },
            },
            { $count: "count" },
          ],
          monthOrderValue: [
            {
              $match: {
                createdAt: { $gte: startOfMonth },
                status: validStatus,
              },
            },
            {
              $group: {
                _id: null,
                orderValue: { $sum: "$paymentDetails.amount" },
              },
            },
          ],
          lastMonthOrderValue: [
            {
              $match: {
                createdAt: { $gte: startOfLastMonth, $lt: startOfMonth },
                status: validStatus,
              },
            },
            {
              $group: {
                _id: null,
                orderValue: { $sum: "$paymentDetails.amount" },
              },
            },
          ],

          // === QUARTER ===
          quarterOrders: [
            { $match: { createdAt: { $gte: startOfQuarter } } },
            { $count: "count" },
          ],
          lastQuarterOrders: [
            {
              $match: {
                createdAt: { $gte: startOfLastQuarter, $lt: startOfQuarter },
              },
            },
            { $count: "count" },
          ],
          quarterOrderValue: [
            {
              $match: {
                createdAt: { $gte: startOfQuarter },
                status: validStatus,
              },
            },
            {
              $group: {
                _id: null,
                orderValue: { $sum: "$paymentDetails.amount" },
              },
            },
          ],
          lastQuarterOrderValue: [
            {
              $match: {
                createdAt: { $gte: startOfLastQuarter, $lt: startOfQuarter },
                status: validStatus,
              },
            },
            {
              $group: {
                _id: null,
                orderValue: { $sum: "$paymentDetails.amount" },
              },
            },
          ],
        },
      },
    ]);

    // Extract results
    const todayOrderCount = result.todaysOrders[0]?.count || 0;
    const todayOrderValue = result.todaysOrderValue[0]?.orderValue || 0;

    const last30Count = result.last30DaysOrders[0]?.count || 0;
    const last30Value = result.last30DaysOrderValue[0]?.orderValue || 0;

    const prev30Count = result.prev30DaysOrders[0]?.count || 0;
    const prev30Value = result.prev30DaysOrderValue[0]?.orderValue || 0;

    const weekCount = result.weekOrders[0]?.count || 0;
    const lastWeekCount = result.lastWeekOrders[0]?.count || 0;

    const monthCount = result.monthOrders[0]?.count || 0;
    const lastMonthCount = result.lastMonthOrders[0]?.count || 0;

    const quarterCount = result.quarterOrders[0]?.count || 0;
    const lastQuarterCount = result.lastQuarterOrders[0]?.count || 0;

    const weekValue = result.weekOrderValue[0]?.orderValue || 0;
    const lastWeekValue = result.lastWeekOrderValue[0]?.orderValue || 0;

    const monthValue = result.monthOrderValue[0]?.orderValue || 0;
    const lastMonthValue = result.lastMonthOrderValue[0]?.orderValue || 0;

    const quarterValue = result.quarterOrderValue[0]?.orderValue || 0;
    const lastQuarterValue = result.lastQuarterOrderValue[0]?.orderValue || 0;

    // === Calculations ===
    const avgDailyOrders = Math.round(last30Count / 30);
    const avgOrderValue =
      last30Count > 0 ? Math.round(last30Value / last30Count) : 0;

    const growthOrders =
      prev30Count > 0
        ? (((last30Count - prev30Count) / prev30Count) * 100).toFixed(2)
        : "0.00";

    const growthValue =
      prev30Value > 0
        ? (((last30Value - prev30Value) / prev30Value) * 100).toFixed(2)
        : "0.00";

    const weekGrowth =
      lastWeekCount > 0
        ? (((weekCount - lastWeekCount) / lastWeekCount) * 100).toFixed(2)
        : "0.00";

    const monthGrowth =
      lastMonthCount > 0
        ? (((monthCount - lastMonthCount) / lastMonthCount) * 100).toFixed(2)
        : "0.00";

    const quarterGrowth =
      lastQuarterCount > 0
        ? (
            ((quarterCount - lastQuarterCount) / lastQuarterCount) *
            100
          ).toFixed(2)
        : "0.00";

    const weekValueGrowth =
      lastWeekValue > 0
        ? (((weekValue - lastWeekValue) / lastWeekValue) * 100).toFixed(2)
        : "0.00";

    const monthValueGrowth =
      lastMonthValue > 0
        ? (((monthValue - lastMonthValue) / lastMonthValue) * 100).toFixed(2)
        : "0.00";

    const quarterValueGrowth =
      lastQuarterValue > 0
        ? (
            ((quarterValue - lastQuarterValue) / lastQuarterValue) *
            100
          ).toFixed(2)
        : "0.00";

    const startOfYesterday = moment()
      .subtract(1, "days")
      .startOf("day")
      .toDate();
    const endOfYesterday = moment().subtract(1, "days").endOf("day").toDate();

    const [yesterdayOrders] = await Order.aggregate([
      {
        $match: {
          ...baseMatch,
          createdAt: { $gte: startOfYesterday, $lte: endOfYesterday },
        },
      },
      { $count: "count" },
    ]);
    const [yesterdayOrderValue] = await Order.aggregate([
      {
        $match: {
          ...baseMatch,
          createdAt: { $gte: startOfYesterday, $lte: endOfYesterday },
          status: validStatus,
        },
      },
      { $group: { _id: null, orderValue: { $sum: "$paymentDetails.amount" } } },
    ]);

    const yesterdayCount = yesterdayOrders?.count || 0;
    const yesterdayValue = yesterdayOrderValue?.orderValue || 0;

    const calculateGrowth = (today, yesterday) => {
      if (yesterday === 0 && today === 0) return "0.00"; // No change
      if (yesterday === 0 && today > 0) return "100.00"; // Fully positive growth
      return (((today - yesterday) / yesterday) * 100).toFixed(2);
    };

    const todayGrowthOrders = calculateGrowth(todayOrderCount, yesterdayCount);
    const todayGrowthValue = calculateGrowth(todayOrderValue, yesterdayValue);

    // === Response ===
    return res.status(200).json({
      success: true,
      data: {
        todayOrderCount,
        todayOrderValue,
        avgDailyOrders,
        avgOrderValue,
        growthOrders,
        growthValue,
        todayGrowthOrders,
        todayGrowthValue,
        statsBreakdown: {
          weekCount,
          weekGrowth,
          monthCount,
          monthGrowth,
          quarterCount,
          quarterGrowth,
        },
        valueBreakdown: {
          week: {
            orderValue: weekValue,
            valueGrowth: weekValueGrowth,
          },
          month: {
            orderValue: monthValue,
            valueGrowth: monthValueGrowth,
          },
          quarter: {
            orderValue: quarterValue,
            valueGrowth: quarterValueGrowth,
          },
        },
      },
    });
  } catch (error) {
    console.error("Business Insights Error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
};

const getDashboardOverview = async (req, res) => {
  try {
    const userId = req.user._id;
    const searchId = req.query.userId;
    const userData = await User.findById(userId);

    const isAdminView = userData?.isAdmin && userData?.adminTab;

    // Filter by user type
    let baseMatch = {};
    if (!isAdminView) {
      baseMatch.userId = userId;
    } else if (searchId) {
      baseMatch.userId = new mongoose.Types.ObjectId(searchId);
    }

    const today = moment().startOf("day").toDate();
    const yesterday = moment().subtract(1, "day").startOf("day").toDate();
    const last30Days = moment().subtract(30, "days").toDate();

    const [result] = await Order.aggregate([
      { $match: baseMatch },
      {
        // ✅ Extract the last tracking date (for delivered orders)
        $addFields: {
          lastTrackingDate: {
            $let: {
              vars: {
                lastItem: { $arrayElemAt: ["$tracking", -1] },
              },
              in: "$$lastItem.StatusDateTime",
            },
          },
        },
      },
      {
        $facet: {
          // 🔹 Order counts
          todaysOrders: [
            { $match: { createdAt: { $gte: today } } },
            { $count: "count" },
          ],
          yesterdaysOrders: [
            { $match: { createdAt: { $gte: yesterday, $lt: today } } },
            { $count: "count" },
          ],

          // 🔹 Today's revenue based on tracking date (not createdAt)
          todaysRevenue: [
            {
              $match: {
                status: { $in: ["In-transit", "Out for Delivery", "Delivered"] },
                lastTrackingDate: { $gte: today },
              },
            },
            {
              $group: {
                _id: null,
                revenue: { $sum: "$totalFreightCharges" },
              },
            },
          ],

          // 🔹 Yesterday's revenue based on tracking date
          yesterdaysRevenue: [
            {
              $match: {
                status: "Delivered",
                lastTrackingDate: { $gte: yesterday, $lt: today },
              },
            },
            {
              $group: {
                _id: null,
                revenue: { $sum: "$totalFreightCharges" },
              },
            },
          ],

          // 🔹 Average shipping cost (last 30 days)
          avgShipping: [
            {
              $match: {
                createdAt: { $gte: last30Days },
                totalFreightCharges: { $gt: 0 },
              },
            },
            {
              $group: {
                _id: null,
                totalFreight: { $sum: "$totalFreightCharges" },
                count: { $sum: 1 },
              },
            },
          ],

          // 🔹 Shipment stats
          totalShipments: [
            { $match: { createdAt: { $gte: last30Days } } },
            { $count: "count" },
          ],
          readyToShip: [
            {
              $match: {
                createdAt: { $gte: last30Days },
                status: "Ready To Ship",
              },
            },
            { $count: "count" },
          ],
          inTransit: [
            {
              $match: {
                createdAt: { $gte: last30Days },
                status: "In-transit",
              },
            },
            { $count: "count" },
          ],
          outForDelivery: [
            {
              $match: {
                createdAt: { $gte: last30Days },
                status: "Out for Delivery",
              },
            },
            { $count: "count" },
          ],
          delivered: [
            {
              $match: { createdAt: { $gte: last30Days }, status: "Delivered" },
            },
            { $count: "count" },
          ],
          rto: [
            {
              $match: {
                createdAt: { $gte: last30Days },
                status: "RTO Delivered",
              },
            },
            { $count: "count" },
          ],

          // 🔹 NDR Stats
          totalNdr: [
            {
              $match: {
                createdAt: { $gte: last30Days },
                ndrStatus: { $exists: true },
              },
            },
            { $count: "count" },
          ],
          actionRequired: [
            {
              $match: {
                createdAt: { $gte: last30Days },
                ndrStatus: "Undelivered",
              },
            },
            { $count: "count" },
          ],
          actionRequested: [
            {
              $match: {
                createdAt: { $gte: last30Days },
                ndrStatus: "Action_Requested",
              },
            },
            { $count: "count" },
          ],
          ndrDelivered: [
            {
              $match: {
                createdAt: { $gte: last30Days },
                ndrStatus: "Delivered",
              },
            },
            { $count: "count" },
          ],
        },
      },
    ]);

    // COD aggregation
    const codSummary = await Cod.aggregate([
      { $match: baseMatch },
      { $unwind: "$remittanceData" },
      {
        $group: {
          _id: null,
          codAvailable: { $sum: "$remittanceData.codAvailable" },
          codTotal: { $sum: "$remittanceData.amountCreditedToWallet" },
          codPending: {
            $sum: {
              $cond: [
                { $eq: ["$remittanceData.status", "Pending"] },
                "$remittanceData.codAvailable",
                0,
              ],
            },
          },
          lastCODRemitted: {
            $max: {
              $cond: [
                { $eq: ["$remittanceData.status", "Paid"] },
                "$remittanceData.date",
                null,
              ],
            },
          },
        },
      },
    ]);

    const codData = codSummary[0] || {};
    const avgShippingData = result.avgShipping[0] || {};

    const avgShippingCost =
      avgShippingData.count > 0
        ? Math.round(avgShippingData.totalFreight / avgShippingData.count)
        : 0;

    const totalNdr =
      (result.actionRequired[0]?.count || 0) +
      (result.actionRequested[0]?.count || 0) +
      (result.ndrDelivered[0]?.count || 0);

    return res.status(200).json({
      success: true,
      data: {
        todaysOrders: result.todaysOrders[0]?.count || 0,
        yesterdaysOrders: result.yesterdaysOrders[0]?.count || 0,
        todaysRevenue: result.todaysRevenue[0]?.revenue || 0,
        yesterdaysRevenue: result.yesterdaysRevenue[0]?.revenue || 0,
        avgShippingCost,

        codAvailable: codData.codAvailable || 0,
        codTotal: codData.codTotal || 0,
        codPending: codData.codPending || 0,
        lastCODRemitted: codData.codTotal || 0,
        lastCODRemittedDate: codData.lastCODRemitted || null,

        shipmentStats: {
          total: result.totalShipments[0]?.count || 0,
          readyToShip: result.readyToShip[0]?.count || 0,
          inTransit: result.inTransit[0]?.count || 0,
          outForDelivery: result.outForDelivery[0]?.count || 0,
          delivered: result.delivered[0]?.count || 0,
          rto: result.rto[0]?.count || 0,
        },

        ndrStats: {
          totalNdr,
          actionRequired: result.actionRequired[0]?.count || 0,
          actionRequested: result.actionRequested[0]?.count || 0,
          ndrDelivered: result.ndrDelivered[0]?.count || 0,
        },
      },
    });
  } catch (error) {
    console.error("Dashboard Overview Error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
};

const getOverviewGraphsData = async (req, res) => {
  try {
    const userId = req.user._id;

    const searchId = req.query.userId;

    const userData = await User.findById(userId);
    // Check if admin and has adminTab access
    const isAdminView = userData?.isAdmin && userData?.adminTab;

    // Determine final user filter
    let baseMatch = {};
    if (!isAdminView) {
      // Normal user: restrict to their own orders
      baseMatch.userId = userId;
    } else if (searchId) {
      // Admin with a selected user
      baseMatch.userId = new mongoose.Types.ObjectId(searchId);
    }
    const last30Days = moment().subtract(30, "days").toDate();

    const [result] = await Order.aggregate([
      {
        $match: {
          ...baseMatch,
          createdAt: { $gte: last30Days },
        },
      },
      {
        $facet: {
          // Apply filter for courier split only
          ordersByProvider: [
            {
              $match: {
                $or: [{ provider: { $ne: null } }, { status: { $ne: "new" } }],
              },
            },
            {
              $group: {
                _id: { $ifNull: ["$provider", "Ecom Express"] },
                value: { $sum: 1 },
              },
            },
            {
              $project: {
                name: "$_id",
                value: 1,
                _id: 0,
              },
            },
          ],

          // No filtering here — include all orders
          paymentModeStats: [
            {
              $group: {
                _id: "$paymentDetails.method",
                value: { $sum: 1 },
              },
            },
            {
              $project: {
                name: "$_id",
                value: 1,
                _id: 0,
              },
            },
          ],
        },
      },
    ]);

    return res.status(200).json({
      success: true,
      data: {
        couriersSplit: result.ordersByProvider || [],
        paymentMode: result.paymentModeStats || [],
        deliveryPerformance: result.deliveryPerformanceStats || [],
      },
    });
  } catch (error) {
    console.error("Overview Graphs Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch overview graph data",
      error: error.message,
    });
  }
};

const getOverviewCardData = async (req, res) => {
  try {
    const userId = req.user._id;

    const searchId = req.query.userId;

    const userData = await User.findById(userId);
    // Check if admin and has adminTab access
    const isAdminView = userData?.isAdmin && userData?.adminTab;

    // Determine final user filter
    let baseMatch = {};
    if (!isAdminView) {
      // Normal user: restrict to their own orders
      baseMatch.userId = userId;
    } else if (searchId) {
      // Admin with a selected user
      baseMatch.userId = new mongoose.Types.ObjectId(searchId);
    }

    const startOfMonth = moment().startOf("month").toDate();
    const startOfWeek = moment().startOf("week").toDate();
    const startOfQuarter = moment().startOf("quarter").toDate();
    const last90Days = moment().subtract(90, "days").toDate();
    const last30Days = moment().subtract(30, "days").toDate();

    const [result] = await Order.aggregate([
      { $match: baseMatch },
      {
        $facet: {
          ordersByZone: [
            {
              $match: {
                createdAt: { $gte: last30Days },
              },
            },
            {
              $group: {
                _id: "$zone",
                count: { $sum: 1 },
              },
            },
            {
              $project: {
                zone: "$_id",
                count: 1,
                _id: 0,
              },
            },
          ],

          totalOrders: [{ $count: "count" }],

          last90DaysRevenue: [
            {
              $match: {
                status: "Delivered",
                createdAt: { $gte: last90Days },
              },
            },
            {
              $group: {
                _id: null,
                revenue: { $sum: "$paymentDetails.amount" },
              },
            },
          ],
          thisMonthRevenue: [
            {
              $match: {
                status: "Delivered",
                createdAt: { $gte: startOfMonth },
              },
            },
            {
              $group: {
                _id: null,
                revenue: { $sum: "$paymentDetails.amount" },
              },
            },
          ],
          thisWeekRevenue: [
            {
              $match: {
                status: "Delivered",
                createdAt: { $gte: startOfWeek },
              },
            },
            {
              $group: {
                _id: null,
                revenue: { $sum: "$paymentDetails.amount" },
              },
            },
          ],
          thisQuarterRevenue: [
            {
              $match: {
                status: "Delivered",
                createdAt: { $gte: startOfQuarter },
              },
            },
            {
              $group: {
                _id: null,
                revenue: { $sum: "$paymentDetails.amount" },
              },
            },
          ],

          weightSplit: [
            {
              $match: {
                ...baseMatch,
                createdAt: { $gte: last30Days },
              },
            },
            {
              $project: {
                weight: {
                  $ifNull: [
                    "$packageDetails.applicableWeight",
                    "$packageDetails.deadWeight",
                  ],
                },
              },
            },
            {
              $bucket: {
                groupBy: "$weight",
                boundaries: [0, 0.5, 1, 2, 5, 10, 1000],
                default: "Other",
                output: {
                  count: { $sum: 1 },
                },
              },
            },
            {
              $project: {
                range: {
                  $switch: {
                    branches: [
                      { case: { $eq: ["$_id", 0] }, then: "0kg to 0.5kg" },
                      { case: { $eq: ["$_id", 0.5] }, then: "0.5kg to 1kg" },
                      { case: { $eq: ["$_id", 1] }, then: "1kg to 2kg" },
                      { case: { $eq: ["$_id", 2] }, then: "2kg to 5kg" },
                      { case: { $eq: ["$_id", 5] }, then: "5kg to 10kg" },
                      { case: { $eq: ["$_id", 10] }, then: "> 10kg" },
                    ],
                    default: "Other",
                  },
                },
                count: 1,
                _id: 0,
              },
            },
          ],
        },
      },
    ]);

    const {
      ordersByZone = [],
      totalOrders = [],
      last90DaysRevenue = [],
      thisMonthRevenue = [],
      thisWeekRevenue = [],
      thisQuarterRevenue = [],
      weightSplit = [],
    } = result;

    const totalOrderCount = totalOrders[0]?.count || 0;

    const ordersByZoneWithPercentage = ordersByZone.map((zone) => {
      const percentage =
        totalOrderCount > 0
          ? ((zone.count / totalOrderCount) * 100).toFixed(2)
          : "0.00";
      return {
        zone: zone.zone,
        percentage: Number(percentage),
      };
    });

    return res.status(200).json({
      success: true,
      data: {
        ordersByZone: ordersByZoneWithPercentage,
        revenueStats: {
          last90Days: last90DaysRevenue[0]?.revenue || 0,
          thisMonth: thisMonthRevenue[0]?.revenue || 0,
          thisWeek: thisWeekRevenue[0]?.revenue || 0,
          thisQuarter: thisQuarterRevenue[0]?.revenue || 0,
        },
        weightSplit: weightSplit, // already has range and count
      },
    });
  } catch (error) {
    console.error("Overview Card Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch dashboard card data",
      error: error.message,
    });
  }
};

const getOrderSummary = async (req, res) => {
  try {
    const userId = req.user._id;
    const searchId = req.query.userId;
    // Extract filters
    const { startDate, endDate, zone, courier, paymentMode } = req.query;
    // console.log("xone", zone);
    const userData = await User.findById(userId);
    const isAdminView = userData?.isAdmin && userData?.adminTab;
    let baseMatch = {};
    if (!isAdminView) {
      baseMatch.userId = userId;
    } else if (searchId) {
      baseMatch.userId = new mongoose.Types.ObjectId(searchId);
    }
    // Base match filter
    const matchFilter = baseMatch;

    if (startDate && endDate) {
      matchFilter.createdAt = {
        $gte: new Date(startDate),
        $lte: new Date(endDate),
      };
    }

    if (zone) matchFilter.zone = zone;
    if (courier) matchFilter.provider = courier;
    if (paymentMode) matchFilter["paymentDetails.method"] = paymentMode;

    // Fetch total orders first to compute percentages
    const totalOrders = await Order.countDocuments(matchFilter);

    // Define statuses to count
    const statusList = [
      "new",
      "Ready To Ship",
      "In-transit",
      "Out for Delivery",
      "Delivered",
      "Cancelled",
      "Undelivered",
      "Lost",
      "Damaged",
    ];

    // Fetch counts for each status
    const statusCounts = await Order.aggregate([
      { $match: matchFilter },
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
        },
      },
    ]);

    const statusMap = {};
    statusCounts.forEach(({ _id, count }) => {
      statusMap[_id] = count;
    });

    const getPercent = (count) =>
      totalOrders > 0
        ? ((count / totalOrders) * 100).toFixed(2) + "%"
        : "0.00%";

    // Construct response structure
    const summaryData = {
      totalOrders,
      new: {
        count: statusMap["new"] || 0,
        percent: getPercent(statusMap["new"] || 0),
      },
      readyToShip: {
        count: statusMap["Ready To Ship"] || 0,
        percent: getPercent(statusMap["Ready To Ship"] || 0),
      },
      inTransit: {
        count: statusMap["In-transit"] || 0,
        percent: getPercent(statusMap["In-transit"] || 0),
      },
      outForDelivery: {
        count: statusMap["Out for Delivery"] || 0,
        percent: getPercent(statusMap["Out for Delivery"] || 0),
      },
      delivered: {
        count: statusMap["Delivered"] || 0,
        percent: getPercent(statusMap["Delivered"] || 0),
      },
      cancelled: {
        count: statusMap["Cancelled"] || 0,
        percent: getPercent(statusMap["Cancelled"] || 0),
      },
      undelivered: {
        count: statusMap["Undelivered"] || 0,
        percent: getPercent(statusMap["Undelivered"] || 0),
      },
      lost: {
        count: statusMap["Lost"] || 0,
        percent: getPercent(statusMap["Lost"] || 0),
      },
      damaged: {
        count: statusMap["Damaged"] || 0,
        percent: getPercent(statusMap["Damaged"] || 0),
      },
    };
    // console.log("sum", summaryData);
    return res.status(200).json({
      success: true,
      data: summaryData,
    });
  } catch (error) {
    console.error("getOrderSummary error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal Server Error",
      error: error.message,
    });
  }
};

const getOrdersGraphsData = async (req, res) => {
  try {
    const userId = req.user._id;
    const searchId = req.query.userId;
    const { startDate, endDate, zone, courier, paymentMode } = req.query;
    const userData = await User.findById(userId);
    const isAdminView = userData?.isAdmin && userData?.adminTab;
    // let baseMatch={};
    let baseMatch = {
      provider: { $ne: null },
      zone: { $nin: [null, "", undefined] },
    };

    if (!isAdminView) {
      baseMatch.userId = userId;
    } else if (searchId) {
      baseMatch.userId = new mongoose.Types.ObjectId(searchId);
    }

    if (startDate && endDate) {
      baseMatch.createdAt = {
        $gte: new Date(startDate),
        $lte: new Date(endDate),
      };
    }

    if (zone) {
      baseMatch.zone = zone;
    }

    if (courier) {
      baseMatch.provider = courier;
    }

    if (paymentMode) {
      baseMatch["paymentDetails.method"] = paymentMode;
    }

    const [results] = await Order.aggregate([
      { $match: baseMatch },
      {
        $facet: {
          couriersSplit: [
            {
              $group: {
                _id: "$provider",
                value: { $sum: 1 },
              },
            },
            {
              $project: {
                name: "$_id",
                value: 1,
                _id: 0,
              },
            },
          ],
          paymentMode: [
            {
              $group: {
                _id: "$paymentDetails.method",
                value: { $sum: 1 },
              },
            },
            {
              $project: {
                name: "$_id",
                value: 1,
                _id: 0,
              },
            },
          ],
          zone: [
            {
              $group: {
                _id: "$zone",
                value: { $sum: 1 },
              },
            },
            {
              $project: {
                name: "$_id",
                value: 1,
                _id: 0,
              },
            },
          ],
        },
      },
    ]);

    res.status(200).json({
      success: true,
      data: {
        couriersSplit: results.couriersSplit,
        paymentMode: results.paymentMode,
        zone: results.zone,
      },
    });
  } catch (error) {
    console.error("Graph Controller Error:", error.message);
    res.status(500).json({
      success: false,
      message: "Internal Server Error",
      error: error.message,
    });
  }
};

const getRTOSummaryData = async (req, res) => {
  try {
    const userId = req.user._id;
    const searchId = req.query.userId;
    const { startDate, endDate, courier, paymentMode, zone } = req.query;

    const userData = await User.findById(userId);
    const isAdminView = userData?.isAdmin && userData?.adminTab;

    const match = {
      status: { $in: ["RTO", "RTO In-transit", "RTO Delivered"] },
    };

    if (!isAdminView) {
      match.userId = userId;
    } else if (searchId) {
      match.userId = new mongoose.Types.ObjectId(searchId);
    }

    if (startDate && endDate) {
      match.createdAt = {
        $gte: new Date(startDate),
        $lte: new Date(endDate),
      };
    }

    if (courier) {
      match.provider = courier;
    }

    if (paymentMode) {
      match["paymentDetails.method"] = paymentMode;
    }

    if (zone) {
      match.zone = zone;
    }

    const result = await Order.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$status",
          value: { $sum: 1 },
        },
      },
    ]);

    const summary = {
      total: 0,
      initiated: 0,
      inTransit: 0,
      delivered: 0,
    };

    result.forEach((item) => {
      summary.total += item.value;
      switch (item._id) {
        case "RTO":
          summary.initiated = item.value;
          break;
        case "RTO In-transit":
          summary.inTransit = item.value;
          break;
        case "RTO Delivered":
          summary.delivered = item.value;
          break;
        default:
          break;
      }
    });

    const percent = (val) =>
      summary.total ? ((val / summary.total) * 100).toFixed(2) + "%" : "0.00%";

    res.json({
      success: true,
      data: {
        total: summary.total,
        initiated: {
          count: summary.initiated,
          percent: percent(summary.initiated),
        },
        inTransit: {
          count: summary.inTransit,
          percent: percent(summary.inTransit),
        },
        delivered: {
          count: summary.delivered,
          percent: percent(summary.delivered),
        },
      },
    });
  } catch (err) {
    console.error("RTO Summary Error:", err);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
};

const getRTOGraphsData = async (req, res) => {
  try {
    const userId = req.user._id;
    const searchId = req.query.userId;
    const { startDate, endDate, courier, zone, paymentMode } = req.query;

    const userData = await User.findById(userId);
    const isAdminView = userData?.isAdmin && userData?.adminTab;

    const match = {
      status: { $in: ["RTO", "RTO In-transit", "RTO Delivered"] }, // RTO-specific
    };

    if (!isAdminView) {
      match.userId = userId;
    } else if (searchId) {
      match.userId = new mongoose.Types.ObjectId(searchId);
    }

    if (startDate && endDate) {
      match.createdAt = {
        $gte: new Date(startDate),
        $lte: new Date(endDate),
      };
    }

    if (courier) {
      match.provider = courier;
    }

    if (paymentMode) {
      match["paymentDetails.method"] = paymentMode;
    }

    if (zone) {
      match.zone = zone;
    }

    const [results] = await Order.aggregate([
      { $match: match },
      {
        $facet: {
          couriersSplit: [
            {
              $group: {
                _id: "$provider",
                value: { $sum: 1 },
              },
            },
            {
              $project: {
                name: "$_id",
                value: 1,
                _id: 0,
              },
            },
          ],
          paymentMode: [
            {
              $group: {
                _id: "$paymentDetails.method",
                value: { $sum: 1 },
              },
            },
            {
              $project: {
                name: "$_id",
                value: 1,
                _id: 0,
              },
            },
          ],
          zone: [
            {
              $match: { zone: { $ne: null } }, // skip orders without zone
            },
            {
              $group: {
                _id: "$zone",
                value: { $sum: 1 },
              },
            },
            {
              $project: {
                name: "$_id",
                value: 1,
                _id: 0,
              },
            },
          ],
        },
      },
    ]);

    res.status(200).json({
      success: true,
      data: {
        couriersSplit: results.couriersSplit,
        paymentMode: results.paymentMode,
        zone: results.zone,
      },
    });
  } catch (error) {
    console.error("RTO Graph Error:", error.message);
    res.status(500).json({
      success: false,
      message: "Internal Server Error",
      error: error.message,
    });
  }
};

const getCourierComparison = async (req, res) => {
  try {
    const userId = req.user._id;
    const searchId = req.query.userId;

    const userData = await User.findById(userId);
    const isAdminView = userData?.isAdmin && userData?.adminTab;

    let baseMatch = { courierServiceName: { $ne: null } };

    if (!isAdminView) {
      baseMatch.userId = userId;
    } else if (searchId) {
      baseMatch.userId = new mongoose.Types.ObjectId(searchId);
    }

    const orders = await Order.aggregate([
      { $match: baseMatch },
      {
        $group: {
          _id: {
            provider: "$provider",
            courierServiceName: "$courierServiceName",
          },
          shipmentCount: { $sum: 1 },
          codOrders: {
            $sum: {
              $cond: [{ $eq: ["$paymentDetails.method", "COD"] }, 1, 0],
            },
          },
          prepaidOrders: {
            $sum: {
              $cond: [{ $eq: ["$paymentDetails.method", "Prepaid"] }, 1, 0],
            },
          },
          delivered: {
            $sum: {
              $cond: [{ $eq: ["$status", "Delivered"] }, 1, 0],
            },
          },
          firstAttempt: {
            $sum: {
              $cond: [{ $eq: ["$firstAttemptDelivered", true] }, 1, 0],
            },
          },
          ndrDelivered: {
            $sum: {
              $cond: [{ $eq: ["$ndrStatus", "Delivered"] }, 1, 0],
            },
          },
          ndrRaised: {
            $sum: {
              $cond: [{ $eq: ["$ndrStatus", "Raised"] }, 1, 0],
            },
          },
          rto: {
            $sum: {
              $cond: [{ $eq: ["$status", "RTO"] }, 1, 0],
            },
          },
          lostOrDamaged: {
            $sum: {
              $cond: [{ $in: ["$status", ["Lost", "Damaged"]] }, 1, 0],
            },
          },
          zoneA: {
            $sum: {
              $cond: [{ $eq: ["$zone", "zoneA"] }, 1, 0],
            },
          },
          zoneB: {
            $sum: {
              $cond: [{ $eq: ["$zone", "zoneB"] }, 1, 0],
            },
          },
          zoneC: {
            $sum: {
              $cond: [{ $eq: ["$zone", "zoneC"] }, 1, 0],
            },
          },
          zoneD: {
            $sum: {
              $cond: [{ $eq: ["$zone", "zoneD"] }, 1, 0],
            },
          },
          zoneE: {
            $sum: {
              $cond: [{ $eq: ["$zone", "zoneE"] }, 1, 0],
            },
          },
        },
      },
      { $sort: { shipmentCount: -1 } }, // 🔥 Sort by shipmentCount descending
    ]);

    const formatted = orders.map((o) => ({
      courier: o._id.provider,
      courierServiceName: o._id.courierServiceName,
      shipmentCount: o.shipmentCount || "-",
      codOrders: o.codOrders || "-",
      prepaidOrders: o.prepaidOrders || "-",
      delivered: o.delivered || "-",
      firstAttempt: o.firstAttempt || "-",
      ndrDelivered: o.ndrDelivered || "-",
      ndrRaised: o.ndrRaised || "-",
      rto: o.rto || "-",
      "Lost/Damaged": o.lostOrDamaged || "-",
      "Zone A": o.zoneA || 0,
      "Zone B": o.zoneB || 0,
      "Zone C": o.zoneC || 0,
      "Zone D": o.zoneD || 0,
      "Zone E": o.zoneE || 0,
    }));

    return res.status(200).json({
      success: true,
      data: formatted,
    });
  } catch (error) {
    console.error("Courier Comparison Error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
};

const getWeightDisputeData = async (req, res) => {
  try {
    const userId = req.user._id;
    const searchId = req.query.userId;

    const userData = await User.findById(userId);
    // Check if admin and has adminTab access
    const isAdminView = userData?.isAdmin && userData?.adminTab;

    // Determine filter
    let baseMatch = {};
    if (!isAdminView) {
      // Normal user → only their disputes
      baseMatch.userId = userId;
    } else if (searchId) {
      // Admin with a selected user → that user's disputes
      baseMatch.userId = new mongoose.Types.ObjectId(searchId);
    }

    // Fetch disputes based on filter
    const allDisputes = await WeightDispute.find(baseMatch)
      .populate("orderId")
      .populate("userId")
      .sort({ createdAt: -1 })
      .lean();

    if (!allDisputes || allDisputes.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No weight disputes found.",
        data: [],
        counts: { New: 0, Accepted: 0, "Discrepancy Raised": 0 },
      });
    }

    // Count by status (only New, Accepted, Discrepancy Raised)
    const counts = allDisputes.reduce(
      (acc, dispute) => {
        const status = dispute.status || "Unknown";
        if (status === "new") acc.New++;
        else if (status === "Accepted") acc.Accepted++;
        else if (status === "Discrepancy Raised") acc["DiscrepancyRaised"]++;
        return acc;
      },
      { New: 0, Accepted: 0, DiscrepancyRaised: 0 }
    );

    return res.status(200).json({
      success: true,
      message: "Weight dispute data retrieved successfully.",
      total: allDisputes.length,
      counts,
      data: allDisputes,
    });
  } catch (error) {
    console.error("Error fetching weight dispute data:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error while retrieving weight dispute data.",
      error: error.message,
    });
  }
};

module.exports = {
  dashboard,
  getBusinessInsights,
  getDashboardOverview,
  getOverviewGraphsData,
  getOverviewCardData,
  getOrderSummary,
  getOrdersGraphsData,
  getRTOSummaryData,
  getRTOGraphsData,
  getCourierComparison,
  getWeightDisputeData,
};
