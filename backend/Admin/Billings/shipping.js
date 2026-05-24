const mongoose = require("mongoose");
const NewOrder = require("../../models/newOrder.model");
const User = require("../../models/User.model");
const AllocateRole = require("../../models/allocateRoleSchema");
const WeightDiscrepancy = require("../../WeightDispreancy/weightDispreancy.model");

const getAllShippingTransactions = async (req, res) => {
  try {
    const {
      userSearch,
      fromDate,
      toDate,
      page = 1,
      limit = 20,
      awbNumber,
      orderId,
      status,
      provider,
    } = req.query;

    const userMatchStage = {};
    const orderMatchStage = {};

    // ✅ Exclude "new" and "cancelled" orders
    orderMatchStage["status"] = { $nin: ["new", "cancelled"] };

    // Employee filtering logic
    let allocatedUserIds = null;
    if (req.employee && req.employee.employeeId) {
      const allocations = await AllocateRole.find({
        employeeId: req.employee.employeeId,
      });
      allocatedUserIds = allocations.map((a) => a.sellerMongoId.toString());
      if (allocatedUserIds.length === 0) {
        return res.json({
          total: 0,
          page: Number(page),
          limit: limit === "all" ? "all" : Number(limit),
          results: [],
        });
      }
      orderMatchStage["userId"] = {
        $in: allocatedUserIds.map((id) => new mongoose.Types.ObjectId(id)),
      };
    }

    // User search filter
    if (userSearch) {
      const regex = new RegExp(userSearch, "i");
      if (mongoose.Types.ObjectId.isValid(userSearch)) {
        userMatchStage["$or"] = [
          { userId: new mongoose.Types.ObjectId(userSearch) },
          { email: regex },
          { fullname: regex },
        ];
      } else {
        userMatchStage["$or"] = [{ email: regex }, { fullname: regex }];
      }
    }

    // Date range filter
    if (fromDate && toDate) {
      const startDate = new Date(new Date(fromDate).setHours(0, 0, 0, 0));
      const endDate = new Date(new Date(toDate).setHours(23, 59, 59, 999));
      orderMatchStage["createdAt"] = { $gte: startDate, $lte: endDate };
    }

    // ✅ If specific status is given, apply it (and still exclude "new" + "cancelled")
    if (status) {
      orderMatchStage["status"] = {
        $eq: status,
        $nin: ["new", "cancelled"],
      };
    }

    if (provider) {
      orderMatchStage["provider"] = provider;
    }

    // Courier service filter (supports multiple couriers)
    if (req.query.courierServiceName) {
      const couriers = req.query.courierServiceName.split(",").map(c => c.trim());
      if (couriers.length === 1) {
        orderMatchStage["courierServiceName"] = couriers[0];
      } else {
        orderMatchStage["courierServiceName"] = { $in: couriers };
      }
    }

    if (awbNumber) {
      orderMatchStage["awb_number"] = awbNumber;
    }

    if (orderId) {
      orderMatchStage["orderId"] = Number(orderId);
    }

    const parsedLimit = limit === "all" ? 0 : Number(limit);
    const skip = (Number(page) - 1) * parsedLimit;

    const basePipeline = [
      { $match: orderMatchStage },
      { $sort: { createdAt: -1 } },
      {
        $lookup: {
          from: "users",
          localField: "userId",
          foreignField: "_id",
          as: "user",
        },
      },
      { $unwind: "$user" },
      { $match: userMatchStage },
      {
        $project: {
          _id: 1,
          orderId: 1,
          awb_number: 1,
          orderType: 1,
          courierServiceName: 1,
          provider: 1,
          totalFreightCharges: 1,
          createdAt: 1,
          shipmentCreatedAt: 1,
          status: 1,
          ndrStatus: 1,
          paymentMethod: "$paymentDetails.method",
          paymentAmount: "$paymentDetails.amount",
          user: {
            userId: "$user.userId",
            name: "$user.fullname",
            email: "$user.email",
            phoneNumber: "$user.phoneNumber",
          },
          pickupAddress: 1,
          receiverAddress: 1,
          productDetails: 1,
          packageDetails: 1,
          B2BPackageDetails: 1,
          priceBreakup: 1,
          rateBreakup: 1,
        },
      },
      
    ];

    const [results, totalResult] = await Promise.all([
      parsedLimit === 0
        ? NewOrder.aggregate(basePipeline)
        : NewOrder.aggregate([
          ...basePipeline,
          { $skip: skip },
          { $limit: parsedLimit },
        ]),
      NewOrder.aggregate([...basePipeline, { $count: "total" }]),
    ]);

    const total = totalResult[0]?.total || 0;

    // Extract unique courier services for filter dropdown
    const courierServices = await NewOrder.distinct("courierServiceName", {
      ...orderMatchStage,
      courierServiceName: { $exists: true, $ne: null, $ne: "" }
    });

    // Attach WeightDiscrepancy data for each order
    const awbNumbers = results.map(o => o.awb_number).filter(Boolean);
    if (awbNumbers.length > 0) {
      const discrepancies = await WeightDiscrepancy.find(
        { awbNumber: { $in: awbNumbers } },
        { chargedWeight: 1, chargeDimension: 1, excessWeightCharges: 1, awbNumber: 1 }
      ).lean();
      const discMap = {};
      for (const d of discrepancies) discMap[d.awbNumber] = d;
      for (const o of results) o.weightDiscrepancy = discMap[o.awb_number] || null;
    }

    return res.json({
      total,
      page: Number(page),
      limit: parsedLimit === 0 ? "all" : parsedLimit,
      results,
      courierServices: courierServices.filter(Boolean).sort(), // Return sorted unique couriers
    });
  } catch (error) {
    console.error("Error in getAllShippingTransactions:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

module.exports = { getAllShippingTransactions };
