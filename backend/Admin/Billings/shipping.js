const mongoose = require("mongoose");
const NewOrder = require("../../models/newOrder.model");
const User = require("../../models/User.model");
const AllocateRole = require("../../models/allocateRoleSchema");

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
          _id: 0,
          orderId: 1,
          awb_number: 1,
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
        },
      },
      { $sort: { createdAt: -1 } },
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

    return res.json({
      total,
      page: Number(page),
      limit: parsedLimit === 0 ? "all" : parsedLimit,
      results,
    });
  } catch (error) {
    console.error("Error in getAllShippingTransactions:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

module.exports = { getAllShippingTransactions };
