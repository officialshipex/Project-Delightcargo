const User = require("../../models/User.model");
const CodRemittance = require("../../COD/codRemittance.model");
const AllocateRole = require("../../models/allocateRoleSchema");
const mongoose = require("mongoose");

const getAllCodRemittance = async (req, res) => {
  try {
    const {
      userSearch,
      fromDate,
      toDate,
      status,
      page = 1,
      limit = 20,
      remittanceId,
      utr,
    } = req.query;

    // console.log('req.query', req.query);

    const parsedLimit = limit === "all" ? 0 : Number(limit);
    const skip = (Number(page) - 1) * (parsedLimit || 0);

    // ---------- Base filters ----------
    const userIdFilter = {};
    const remittanceMatchStage = {};

    // Employee allocation filter
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
            totalCodRemitted: 0,
            totalDeductions: 0,
            totalRemittanceInitiated: 0,
          },
        });
      }
      userIdFilter.userId = { $in: allocatedUserIds };
    }

    // Date filter
    if (fromDate && toDate) {
      const startDate = new Date(fromDate);
      startDate.setHours(0, 0, 0, 0);
      const endDate = new Date(toDate);
      endDate.setHours(23, 59, 59, 999);
      remittanceMatchStage["remittanceData.date"] = {
        $gte: startDate,
        $lte: endDate,
      };
    }

    // Status / remittanceId / utr filters
    if (status) remittanceMatchStage["remittanceData.status"] = status;
    if (remittanceId)
      remittanceMatchStage["remittanceData.remittanceId"] = remittanceId;
    if (utr) remittanceMatchStage["remittanceData.utr"] = utr;

    // ---------- Shared base (no unwind) ----------
    const base = [
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
      ...(userSearch
        ? [
          {
            $match: {
              $or: [
                ...(mongoose.Types.ObjectId.isValid(userSearch)
                  ? [{ "user._id": new mongoose.Types.ObjectId(userSearch) }]
                  : []),
                { "user.email": new RegExp(userSearch, "i") },
                { "user.fullname": new RegExp(userSearch, "i") },
              ],
            },
          },
        ]
        : []),
    ];

    // ---------- Aggregation pipeline with safe flattening ----------
    const pipeline = [
      ...base,
      {
        $facet: {
          rows: [
            { $unwind: "$remittanceData" },
            { $match: remittanceMatchStage },
            {
              $group: {
                _id: "$remittanceData.remittanceId",
                doc: { $first: "$$ROOT" },
              },
            },
            { $replaceRoot: { newRoot: "$doc" } },
            {
              $addFields: {
                // Add FLAT fields for safe access
                codAvailableFlat: {
                  $cond: [
                    { $isArray: "$remittanceData.codAvailable" },
                    { $arrayElemAt: ["$remittanceData.codAvailable", 0] },
                    "$remittanceData.codAvailable",
                  ],
                },
                amountCreditedToWalletFlat: {
                  $cond: [
                    { $isArray: "$remittanceData.amountCreditedToWallet" },
                    {
                      $arrayElemAt: [
                        "$remittanceData.amountCreditedToWallet",
                        0,
                      ],
                    },
                    "$remittanceData.amountCreditedToWallet",
                  ],
                },
                earlyCodChargesFlat: {
                  $cond: [
                    { $isArray: "$remittanceData.earlyCodCharges" },
                    { $arrayElemAt: ["$remittanceData.earlyCodCharges", 0] },
                    "$remittanceData.earlyCodCharges",
                  ],
                },
                adjustedAmountFlat: {
                  $cond: [
                    { $isArray: "$remittanceData.adjustedAmount" },
                    { $arrayElemAt: ["$remittanceData.adjustedAmount", 0] },
                    "$remittanceData.adjustedAmount",
                  ],
                },
              },
            },
            {
              $addFields: {
                codAvailableNum: {
                  $toDouble: { $ifNull: ["$codAvailableFlat", 0] },
                },
                amountCreditedToWalletNum: {
                  $toDouble: { $ifNull: ["$amountCreditedToWalletFlat", 0] },
                },
                earlyCodChargesNum: {
                  $toDouble: { $ifNull: ["$earlyCodChargesFlat", 0] },
                },
                adjustedAmountNum: {
                  $toDouble: { $ifNull: ["$adjustedAmountFlat", 0] },
                },
                // NEW LOGIC: codAvailableSum = codAvailableNum + amountCreditedToWalletNum + earlyCodChargesNum
                codAvailableSum: {
                  $add: [
                    { $toDouble: { $ifNull: ["$codAvailableFlat", 0] } },
                    {
                      $toDouble: {
                        $ifNull: ["$amountCreditedToWalletFlat", 0],
                      },
                    },
                    { $toDouble: { $ifNull: ["$earlyCodChargesFlat", 0] } },
                  ],
                },
                // New field: remittanceInitiated = codAvailableNum (original value)
                remittanceInitiated: {
                  $toDouble: { $ifNull: ["$codAvailableFlat", 0] },
                },
              },
            },
            {
              $project: {
                _id: "$remittanceData._id",
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
                // OUTPUT FIELDS
                codAvailable: "$codAvailableSum", // Combined value as required
                remittanceInitiated: "$remittanceInitiated", // The original codAvailable value
                amountCreditedToWallet: "$amountCreditedToWalletNum",
                earlyCodCharges: "$earlyCodChargesNum",
                adjustedAmount: "$adjustedAmountNum",
              },
            },
            { $sort: { date: -1 } },
            ...(parsedLimit === 0
              ? []
              : [{ $skip: skip }, { $limit: parsedLimit }]),
          ],
          // 2) Total count for pagination (same filters as rows, but just count)
          count: [
            { $unwind: "$remittanceData" },
            { $match: remittanceMatchStage },
            { $count: "total" },
          ],

          // 3) Row-based totals, all lines flattened first
          totals: [
            // Filter docs before unwinding
            { $match: remittanceMatchStage },

            // Flatten and convert RemittanceInitiated
            {
              $addFields: {
                remittanceInitiatedFlat: {
                  $cond: [
                    { $isArray: "$RemittanceInitiated" },
                    { $arrayElemAt: ["$RemittanceInitiated", 0] },
                    "$RemittanceInitiated",
                  ],
                },
              },
            },
            {
              $addFields: {
                remittanceInitiatedNum: {
                  $toDouble: { $ifNull: ["$remittanceInitiatedFlat", 0] },
                },
              },
            },

            // Now unwind for remittanceData aggregation
            { $unwind: "$remittanceData" },
            { $match: remittanceMatchStage },

            {
              $addFields: {
                codAvailableFlat: {
                  $cond: [
                    { $isArray: "$remittanceData.codAvailable" },
                    { $arrayElemAt: ["$remittanceData.codAvailable", 0] },
                    "$remittanceData.codAvailable",
                  ],
                },
                amountCreditedToWalletFlat: {
                  $cond: [
                    { $isArray: "$remittanceData.amountCreditedToWallet" },
                    {
                      $arrayElemAt: [
                        "$remittanceData.amountCreditedToWallet",
                        0,
                      ],
                    },
                    "$remittanceData.amountCreditedToWallet",
                  ],
                },
                earlyCodChargesFlat: {
                  $cond: [
                    { $isArray: "$remittanceData.earlyCodCharges" },
                    { $arrayElemAt: ["$remittanceData.earlyCodCharges", 0] },
                    "$remittanceData.earlyCodCharges",
                  ],
                },
                adjustedAmountFlat: {
                  $cond: [
                    { $isArray: "$remittanceData.adjustedAmount" },
                    { $arrayElemAt: ["$remittanceData.adjustedAmount", 0] },
                    "$remittanceData.adjustedAmount",
                  ],
                },
              },
            },
            {
              $addFields: {
                codAvailableNum: {
                  $toDouble: { $ifNull: ["$codAvailableFlat", 0] },
                },
                amountCreditedToWalletNum: {
                  $toDouble: { $ifNull: ["$amountCreditedToWalletFlat", 0] },
                },
                earlyCodChargesNum: {
                  $toDouble: { $ifNull: ["$earlyCodChargesFlat", 0] },
                },
                adjustedAmountNum: {
                  $toDouble: { $ifNull: ["$adjustedAmountFlat", 0] },
                },
              },
            },

            // Group by _id and use $first for remittanceInitiatedNum
            {
              $group: {
                _id: "$_id",
                totalCodRemitted: {
                  $sum: {
                    $cond: [
                      { $eq: ["$remittanceData.status", "Paid"] },
                      "$codAvailableNum",
                      0,
                    ],
                  },
                },
                totalDeductions: {
                  $sum: {
                    $add: [
                      "$amountCreditedToWalletNum",
                      "$earlyCodChargesNum",
                      "$adjustedAmountNum",
                    ],
                  },
                },
                remittanceInitiatedNum: { $first: "$remittanceInitiatedNum" }, // Root value, not duplicated
              },
            },

            // Sum up across all docs
            {
              $group: {
                _id: null,
                totalCodRemitted: { $sum: "$totalCodRemitted" },
                totalDeductions: { $sum: "$totalDeductions" },
                totalRemittanceInitiated: { $sum: "$remittanceInitiatedNum" },
              },
            },
          ],

          // 4) Snapshot across matched users (no date/status duplication)
          codSnapshot: [
            {
              $addFields: {
                CODToBeRemittedFlat: {
                  $cond: [
                    { $isArray: "$CODToBeRemitted" },
                    { $arrayElemAt: ["$CODToBeRemitted", 0] },
                    "$CODToBeRemitted",
                  ],
                },
              },
            },
            {
              $addFields: {
                CODToBeRemittedNum: {
                  $toDouble: { $ifNull: ["$CODToBeRemittedFlat", 0] },
                },
              },
            },
            {
              $group: {
                _id: null,
                CODToBeRemitted: { $sum: "$CODToBeRemittedNum" },
              },
            },
          ],
        },
      },
    ];

    const [faceted] = await CodRemittance.aggregate(pipeline);

    const rows = faceted.rows || [];
    const total = faceted.count?.[0]?.total || 0;
    // console.log("row",rows)
    const totals = faceted.totals?.[0] || {
      totalCodRemitted: 0,
      totalDeductions: 0,
      totalRemittanceInitiated: 0,
    };
    const pendingEarlyCodCharges = rows.reduce((sum, e) => {
      if (e.status === "Pending") {
        return sum + (e.earlyCodCharges || 0);
      }
      return sum;
    }, 0);
    const codSnap = faceted.codSnapshot?.[0] || { CODToBeRemitted: 0 };
    // console.log("cod", rows);
    return res.json({
      total,
      page: Number(page),
      limit: parsedLimit === 0 ? "all" : parsedLimit,
      results: rows,
      summary: {
        CODToBeRemitted: codSnap.CODToBeRemitted || 0, // snapshot (user-level)
        totalCodRemitted: totals.totalCodRemitted || 0, // from Paid rows
        totalDeductions: totals.totalDeductions || 0, // from visible rows
        totalRemittanceInitiated: totals.totalRemittanceInitiated, // from Pending rows
      },
    });
  } catch (error) {
    console.error("Error in getAllCodRemittance:", error);
    res.status(500).json({ message: "Server error" });
  }
};

module.exports = { getAllCodRemittance };
