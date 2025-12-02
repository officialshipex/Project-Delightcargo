const User = require("../../models/User.model");
const Wallet = require("../../models/wallet");
const AllocateRole = require("../../models/allocateRoleSchema");
const mongoose = require("mongoose");

const getAllPassbookTransactions = async (req, res) => {
  try {
    const {
      userSearch,
      fromDate,
      toDate,
      category,
      description,
      page = 1,
      limit = 20,
      awbNumber,
      orderId,
    } = req.query;

    const userMatchStage = {};
    const transactionFilterConditions = [];

    // --- Employee filtering logic ---
    if (req.employee && req.employee.employeeId) {
      const allocations = await AllocateRole.find({
        employeeId: req.employee.employeeId,
      }).lean();

      const allocatedUserIds = allocations.map((a) =>
        a.sellerMongoId.toString()
      );

      if (allocatedUserIds.length === 0) {
        return res.json({
          total: 0,
          page: Number(page),
          limit: limit === "all" ? "all" : Number(limit),
          results: [],
        });
      }

      userMatchStage["_id"] = {
        $in: allocatedUserIds.map((id) => new mongoose.Types.ObjectId(id)),
      };
    }

    // --- User search (id, email, name) ---
    if (userSearch) {
      const regex = new RegExp(userSearch, "i");
      if (mongoose.Types.ObjectId.isValid(userSearch)) {
        userMatchStage["$or"] = [
          { _id: new mongoose.Types.ObjectId(userSearch) },
          { email: regex },
          { fullname: regex },
        ];
      } else {
        userMatchStage["$or"] = [{ email: regex }, { fullname: regex }];
      }
    }

    // --- Transaction filters ---
    if (fromDate && toDate) {
      const startDate = new Date(new Date(fromDate).setHours(0, 0, 0, 0));
      const endDate = new Date(new Date(toDate).setHours(23, 59, 59, 999));
      transactionFilterConditions.push({
        $and: [
          { $gte: ["$$t.date", startDate] },
          { $lte: ["$$t.date", endDate] },
        ],
      });
    }

    if (category) {
      transactionFilterConditions.push({ $eq: ["$$t.category", category] });
    }

    if(description){
      transactionFilterConditions.push({ $eq: ["$$t.description", description] });
    }

    if (awbNumber) {
      transactionFilterConditions.push({ $eq: ["$$t.awb_number", awbNumber] });
    }

    if (orderId) {
      transactionFilterConditions.push({
        $eq: ["$$t.channelOrderId", orderId],
      });
    }

    const transactionFilter =
      transactionFilterConditions.length > 0
        ? { $and: transactionFilterConditions }
        : true;

    const parsedLimit = limit === "all" ? 0 : Number(limit);
    const skip = (Number(page) - 1) * parsedLimit;

    // --- Aggregation pipeline ---
    const pipeline = [
      { $match: { Wallet: { $ne: null }, ...userMatchStage } },
      {
        $lookup: {
          from: "wallets",
          localField: "Wallet",
          foreignField: "_id",
          as: "wallet",
        },
      },
      { $unwind: "$wallet" },
      {
        $project: {
          fullname: 1,
          email: 1,
          userId: 1,
          phoneNumber: 1,
          transactions: {
            $filter: {
              input: "$wallet.transactions",
              as: "t",
              cond: transactionFilter,
            },
          },
        },
      },
      { $unwind: "$transactions" },
      { $sort: { "transactions.date": -1 } },

      {
        $facet: {
          metadata: [{ $count: "total" }],
          data: [
            ...(parsedLimit > 0
              ? [{ $skip: skip }, { $limit: parsedLimit }]
              : []),
            {
              $lookup: {
                from: "neworders",
                let: { awb: "$transactions.awb_number" },
                pipeline: [
                  {
                    $match: {
                      $expr: { $eq: ["$awb_number", "$$awb"] },
                    },
                  },
                  { $project: { courierServiceName: 1, provider: 1, _id: 0 } },
                ],
                as: "orderInfo",
              },
            },
            {
              $project: {
                user: {
                  _id: "$_id",
                  name: "$fullname",
                  email: "$email",
                  userId: "$userId",
                  phoneNumber: "$phoneNumber",
                },
                id: "$transactions._id",
                category: "$transactions.category",
                amount: "$transactions.amount",
                balanceAfterTransaction:
                  "$transactions.balanceAfterTransaction",
                date: "$transactions.date",
                awb_number: "$transactions.awb_number",
                orderId: "$transactions.channelOrderId",
                description: "$transactions.description",
                courierServiceName: {
                  $ifNull: [
                    { $arrayElemAt: ["$orderInfo.courierServiceName", 0] },
                    null,
                  ],
                },
                provider: {
                  $ifNull: [{ $arrayElemAt: ["$orderInfo.provider", 0] }, null],
                },
              },
            },
          ],
        },
      },
    ];

    const result = await User.aggregate(pipeline);

    const total = result[0]?.metadata[0]?.total || 0;
    const totalPages = parsedLimit === 0 ? 1 : Math.ceil(total / parsedLimit);

    return res.json({
      total,
      totalPages,
      page: Number(page),
      limit: parsedLimit === 0 ? "all" : parsedLimit,
      results: result[0]?.data || [],
    });
  } catch (error) {
    console.error("Error in getAllPassbookTransactions:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

const exportPassbook = async (req, res) => {
  try {
    const { transactionsId } = req.body;
    if (
      !transactionsId ||
      !Array.isArray(transactionsId) ||
      transactionsId.length === 0
    ) {
      return res
        .status(400)
        .json({ message: "transactionsId array is required" });
    }

    // Convert string IDs to ObjectId
    const objectIds = transactionsId
      .filter((id) => mongoose.Types.ObjectId.isValid(id))
      .map((id) => new mongoose.Types.ObjectId(id));

    // Aggregate pipeline to fetch transactions matching given ids
    const pipeline = [
      { $match: { Wallet: { $ne: null } } },
      {
        $lookup: {
          from: "wallets",
          localField: "Wallet",
          foreignField: "_id",
          as: "wallet",
        },
      },
      { $unwind: "$wallet" },
      { $unwind: "$wallet.transactions" },
      {
        $match: {
          "wallet.transactions._id": { $in: objectIds },
        },
      },
      {
        $lookup: {
          from: "neworders",
          let: { awb: "$wallet.transactions.awb_number" },
          pipeline: [
            { $match: { $expr: { $eq: ["$awb_number", "$$awb"] } } },
            {
              $project: {
                courierServiceName: 1,
                provider: 1,
                _id: 0,
              },
            },
          ],
          as: "orderInfo",
        },
      },
      {
        $project: {
          _id: 0,
          user: {
            _id: "$_id",
            name: "$fullname",
            email: "$email",
            userId: "$userId",
            phoneNumber: "$phoneNumber",
          },
          id: "$wallet.transactions._id",
          category: "$wallet.transactions.category",
          amount: "$wallet.transactions.amount",
          balanceAfterTransaction:
            "$wallet.transactions.balanceAfterTransaction",
          date: "$wallet.transactions.date",
          awb_number: "$wallet.transactions.awb_number",
          orderId: "$wallet.transactions.channelOrderId",
          description: "$wallet.transactions.description",
          courierServiceName: {
            $arrayElemAt: ["$orderInfo.courierServiceName", 0],
          },
          provider: { $arrayElemAt: ["$orderInfo.provider", 0] },
        },
      },
      { $sort: { date: -1 } },
    ];

    const results = await User.aggregate(pipeline);

    if (!results || results.length === 0) {
      return res
        .status(404)
        .json({ message: "No transactions found for given IDs" });
    }

    // Build CSV content
    const csvData = results.map((transaction) => ({
      userId: transaction.user.userId,
      userName: transaction.user.name,
      Email: transaction.user.email,
      Category: transaction.category,
      Amount: transaction.amount,
      BalanceAfterTransaction: transaction.balanceAfterTransaction,
      Date: transaction.date.toISOString(),
      AWBNumber: transaction.awb_number || "",
      OrderId: transaction.orderId || "",
      Description: transaction.description || "",
      CourierServiceName: transaction.courierServiceName || "",
      Provider: transaction.provider || "",
    }));

    const csvHeaders = Object.keys(csvData[0]);
    const csvContent = [
      csvHeaders.join(","),
      ...csvData.map((row) =>
        csvHeaders
          .map((header) => `"${String(row[header]).replace(/"/g, '""')}"`)
          .join(",")
      ),
    ].join("\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=passbook_export.csv"
    );
    return res.send(csvContent);
  } catch (error) {
    console.error("Error exporting passbook by IDs:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

module.exports = { getAllPassbookTransactions, exportPassbook };
