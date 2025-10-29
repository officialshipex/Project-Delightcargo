const User = require("../models/User.model");
const Plan = require("../models/Plan.model");
const mongoose = require("mongoose");
const Account = require("../models/BankAccount.model");
const Aadhar = require("../models/Aadhaar.model");
const Pan = require("../models/Pan.model");
const Gst = require("../models/Gstin.model");
const CodPlans = require("../COD/codPan.model");
const AllocateRole = require("../models/allocateRoleSchema");
const Order = require("../models/newOrder.model");
const { generateKeySync } = require("crypto");

// const getUsers = async (req, res) => {
//     try {
//         const allUsers = await User.find({});
//         res.status(201).json({
//             success: true,
//             data: allUsers,
//         });
//     } catch (error) {
//         console.error("Error fetching users:", error);
//         res.status(500).json({
//             success: false,
//             message: "Failed to fetch users",
//             error: error.message,
//         });
//     }
// };

// In user controller
const getUsers = async (req, res) => {
  try {
    let allUsers = [];
    // If employee, filter users by allocations
    if (req.employee && req.employee.employeeId) {
      // Get allocations for this employee
      const allocations = await AllocateRole.find({
        employeeId: req.employee.employeeId,
      });
      const sellerMongoIds = allocations.map((a) => a.sellerMongoId);
      // Fetch only users whose _id is in sellerMongoIds
      allUsers = await User.find({
        _id: { $in: sellerMongoIds },
        kycDone: true,
      });
    } else {
      // Admin: get all users as before
      allUsers = await User.find({ kycDone: true });
    }

    const isSeller = allUsers.some(
      (user) => user._id.toString() === req.user?.id
    );

    res.status(201).json({
      success: true,
      sellers: allUsers.map((user) => ({
        userId: user.userId,
        id: user._id,
        name: `${user.fullname}`,
        fullname: user.fullname,
        email: user.email,
        phoneNumber: user.phoneNumber,
        company: user.company,
        kycStatus: user.kycDone,
        // Add any other fields you want to keep for the frontend
      })),
      isSeller,
    });
  } catch (error) {
    console.error("Error fetching users:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch users",
      error: error.message,
    });
  }
};

const getAllUsers = async (req, res) => {
  try {
    const {
      page = 1,
      limit,
      search = "",
      kycStatus,
      rateCard,
      balanceType,
      id,
      userId,
    } = req.query;

    console.log("Request query params:", req.query);

    const parsedLimit = limit === "All" || !limit ? null : Number(limit);
    const skip = parsedLimit ? (Number(page) - 1) * parsedLimit : 0;

    const query = {};

    // Exact userId match
    if (id && id.trim() !== "") {
      // If you want to fetch using MongoDB's ObjectId
      query._id = new mongoose.Types.ObjectId(id.trim());
    } else if (userId && userId.trim() !== "") {
      // If you want to fetch by userId (6-digit number)
      query.userId = Number(userId.trim()); // 👈 Cast to Number
    } else if (search && search.trim() !== "") {
      const trimmedSearch = search.trim();
      query.$or = [
        { userId: { $regex: trimmedSearch, $options: "i" } }, // Keep this if userId is searchable as a string
        { fullname: { $regex: trimmedSearch, $options: "i" } },
        { email: { $regex: trimmedSearch, $options: "i" } },
        { phoneNumber: { $regex: trimmedSearch, $options: "i" } },
      ];
    }

    // Flexible search
    else if (search && search.trim() !== "") {
      const trimmedSearch = search.trim();
      query.$or = [
        { userId: { $regex: trimmedSearch, $options: "i" } },
        { fullname: { $regex: trimmedSearch, $options: "i" } },
        { email: { $regex: trimmedSearch, $options: "i" } },
        { phoneNumber: { $regex: trimmedSearch, $options: "i" } },
      ];
    }

    if (kycStatus === "verified") query.kycDone = true;
    if (kycStatus === "pending") query.kycDone = false;

    const hasFilters =
      (userId && userId.trim() !== "") || (search && search.trim() !== "");

    // console.log(req.employee)
    // --- User/Employee-based role filtering ---
    if (req.employee && req.employee.employeeId) {
      // console.log("EMPLOYEE ID:", req.employee.employeeId);

      const allocations = await AllocateRole.find({
        employeeId: String(req.employee.employeeId),
      });
      // console.log("ALLOCATIONS FOUND:", allocations);

      const sellerMongoIds = allocations
        .map((a) => a.sellerMongoId)
        .filter(Boolean)
        .map((id) => new mongoose.Types.ObjectId(id));
      // console.log("ALLOCATED SELLERS:", sellerMongoIds);

      if (sellerMongoIds.length > 0) {
        query._id = { $in: sellerMongoIds };
      } else {
        return res.status(200).json({
          success: true,
          userIds: [],
          userDetails: [],
          verifiedKycCount: 0,
          pendingKycCount: 0,
          currentPage: Number(page),
          totalPages: 0,
          totalCount: 0,
        });
      }
    }
    // For all other cases (admin or user), show all users (no filter needed)

    // Fetch all users based on constructed query
    const users = await User.find(query)
      .populate("Wallet", "balance") // Ensure 'wallet' is correct in schema
      .select(
        "userId fullname email phoneNumber company kycDone creditLimit createdAt lastLogin isBlocked"
      )
      .lean();

    // console.log("Fetched users:", users.length);

    const userIds = users.map((u) => u._id);

    const [plans, codPlans, accounts, aadhars, pans, gsts] = await Promise.all([
      Plan.find({ userId: { $in: userIds } }).lean(),
      CodPlans.find({ user: { $in: userIds } }).lean(),
      Account.find({ user: { $in: userIds } }).lean(),
      Aadhar.find({ user: { $in: userIds } }).lean(),
      Pan.find({ user: { $in: userIds } }).lean(),
      Gst.find({ user: { $in: userIds } }).lean(),
    ]);

    const planMap = new Map(plans.map((p) => [String(p.userId), p]));
    const codMap = new Map(codPlans.map((p) => [String(p.user), p]));
    const accountMap = new Map(accounts.map((a) => [String(a.user), a]));
    const aadharMap = new Map(aadhars.map((a) => [String(a.user), a]));
    const panMap = new Map(pans.map((p) => [String(p.user), p]));
    const gstMap = new Map(gsts.map((g) => [String(g.user), g]));

    // Filter by wallet balance & rate card if applied
    const filteredUsers = users.filter((user) => {
      const walletBalance = user.Wallet?.balance || 0;

      if (balanceType === "positive" && walletBalance < 0) return false;
      if (balanceType === "negative" && walletBalance >= 0) return false;

      const plan = planMap.get(String(user._id));
      if (
        rateCard &&
        plan?.planName?.toLowerCase() !== rateCard.toLowerCase()
      ) {
        return false;
      }

      return true;
    });

    const totalCount = filteredUsers.length;
    const totalPages = parsedLimit ? Math.ceil(totalCount / parsedLimit) : 1;

    const paginatedUsers = parsedLimit
      ? filteredUsers.slice(skip, skip + parsedLimit)
      : filteredUsers;
    // console.log("userIds:", userIds);
    // Step 1: Aggregate order count and last order date for all fetched user IDs
    const orderStats = await Order.aggregate([
      {
        $match: {
          userId: { $in: userIds },
        },
      },
      {
        $group: {
          _id: "$userId",
          orderCount: { $sum: 1 },
          lastOrderDate: { $max: "$createdAt" },
        },
      },
    ]);
    // console.log("Order stats:", orderStats);

    // Step 2: Map it by userId for quick access
    const orderStatsMap = new Map(
      orderStats.map((stat) => [String(stat._id), stat])
    );
    // console.log("Order stats map:", orderStatsMap);

    const userDetails = paginatedUsers.map((user) => {
      const walletBalance = user.Wallet?.balance || 0;
      const plan = planMap.get(String(user._id));
      const stats = orderStatsMap.get(String(user._id));

      return {
        id: user._id,
        userId: user.userId,
        fullname: user.fullname,
        email: user.email,
        isBlocked: user?.isBlocked,
        lastLogin: user.lastLogin,
        phoneNumber: user.phoneNumber,
        company: user.company,
        kycStatus: user.kycDone,
        walletAmount: walletBalance,
        creditLimit: user.creditLimit || 0,
        rateCard: plan?.planName || "N/A",
        codPlan: codMap.get(String(user._id))?.planName || "N/A",
        createdAt: user.createdAt,
        orderCount: stats?.orderCount || 0,
        lastOrderDate: stats?.lastOrderDate || null,
        accountDetails: (() => {
          const acc = accountMap.get(String(user._id));
          if (!acc) return null;
          return {
            beneficiaryName: acc.nameAtBank,
            accountNumber: acc.accountNumber,
            ifscCode: acc.ifsc,
            bankName: acc.bank,
            branchName: acc.branch,
          };
        })(),
        aadharDetails: (() => {
          const a = aadharMap.get(String(user._id));
          if (!a) return null;
          return {
            aadharNumber: a.aadhaarNumber,
            nameOnAadhar: a.name,
            state: a.state,
            address: a.address,
          };
        })(),
        panDetails: (() => {
          const p = panMap.get(String(user._id));
          if (!p) return null;
          return {
            panNumber: p.panNumber,
            nameOnPan: p.nameProvided,
            panType: p.pan,
            referenceId: p.panRefId,
          };
        })(),
        gstDetails: (() => {
          const g = gstMap.get(String(user._id));
          if (!g) return null;
          return {
            gstNumber: g.gstin,
            companyAddress: g.address,
            pincode: g.pincode,
            state: g.state,
            city: g.city,
          };
        })(),
      };
    });
    // console.log("user",userDetails)
    return res.status(200).json({
      success: true,
      userIds: userDetails.map((u) => u.userId),
      userDetails,
      verifiedKycCount: await User.countDocuments({ ...query, kycDone: true }),
      pendingKycCount: await User.countDocuments({ ...query, kycDone: false }),
      currentPage: Number(page),
      totalPages,
      totalCount,
    });
  } catch (error) {
    console.error("Error in getAllUsers:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching users",
      error: error.message,
    });
  }
};

const getUserById = async (req, res) => {
  try {
    const { id } = req.query;

    if (!id) {
      return res
        .status(400)
        .json({ success: false, message: "User ID is required" });
    }

    const user = await User.findById(id)
      .populate("Wallet", "balance")
      // .select("userId fullname email phoneNumber company kycDone creditLimit createdAt")
      .lean();
    console.log("user", user);
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    const [plan, codPlan, account, aadhar, pan, gst] = await Promise.all([
      Plan.findOne({ userId: user._id }).lean(),
      CodPlans.findOne({ user: user._id }).lean(),
      Account.findOne({ user: user._id }).lean(),
      Aadhar.findOne({ user: user._id }).lean(),
      Pan.findOne({ user: user._id }).lean(),
      Gst.findOne({ user: user._id }).lean(),
    ]);

    const walletBalance = user.Wallet?.balance || 0;

    const userDetails = {
      id: user._id,
      userId: user.userId,
      fullname: user.fullname,
      email: user.email,
      phoneNumber: user.phoneNumber,
      company: user.company,
      kycStatus: user.kycDone,
      walletAmount: walletBalance,
      creditLimit: user.creditLimit || 0,
      rateCard: plan?.planName || "N/A",
      codPlan: codPlan?.planName || "N/A",
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      isBlocked: user.isBlocked,
      logo: user.profileImage || "",
      referralCode: user.referralCode || "",
      referralCommissionPercentage: user.referralCommissionPercentage || 0,
      accountDetails: account
        ? {
            beneficiaryName: account.nameAtBank,
            accountNumber: account.accountNumber,
            ifscCode: account.ifsc,
            bankName: account.bank,
            branchName: account.branch,
          }
        : null,
      aadharDetails: aadhar
        ? {
            aadharNumber: aadhar.aadhaarNumber,
            nameOnAadhar: aadhar.name,
            state: aadhar.state,
            address: aadhar.address,
          }
        : null,
      panDetails: pan
        ? {
            panNumber: pan.pan,
            nameOnPan: pan.nameProvided,
            panType: pan.pan,
            referenceId: pan.panRefId,
          }
        : null,
      gstDetails: gst
        ? {
            gstNumber: gst.gstin,
            companyAddress: gst.address,
            pincode: gst.pincode,
            state: gst.state,
            city: gst.city,
          }
        : null,
    };
    console.log(userDetails);

    return res.status(200).json({
      success: true,
      userDetails,
    });
  } catch (error) {
    console.error("Error in getUserById:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching user by ID",
      error: error.message,
    });
  }
};

const updateBlockStatus = async (req, res) => {
  try {
    const { userId, isBlocked } = req.body;

    if (!userId) {
      return res.status(400).json({ message: "User ID is required" });
    }

    // Find user
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Update block status
    user.isBlocked = isBlocked;
    await user.save();

    res.status(200).json({
      success: true,
      message: `User has been ${
        isBlocked ? "blocked" : "unblocked"
      } successfully.`,
      user,
    });
  } catch (error) {
    console.error("Error updating user block status:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error while updating user block status.",
      error: error.message,
    });
  }
};

const getUserDetails = async (req, res) => {
  try {
    const userId = req.user._id;

    // Populate only necessary fields (faster)
    const existingUser = await User.findById(userId)
      // .populate("wareHouse", "name address")
      .populate("Wallet", "balance holdAmount");
    // .populate("plan", "name expiryDate rateCard");

    if (!existingUser)
      return res
        .status(404)
        .json({ success: false, message: "User not found" });

    let balance = existingUser?.Wallet?.balance || 0;
    let holdAmount = existingUser?.Wallet?.holdAmount || 0;

    // If admin with adminTab, compute using aggregation
    if (existingUser?.isAdmin && existingUser?.adminTab) {
      const totals = await User.aggregate([
        {
          $lookup: {
            from: "wallets", // collection name must match your Wallet model
            localField: "Wallet",
            foreignField: "_id",
            as: "wallet",
          },
        },
        { $unwind: "$wallet" },
        {
          $group: {
            _id: null,
            totalBalance: { $sum: "$wallet.balance" },
            totalHoldAmount: { $sum: "$wallet.holdAmount" },
          },
        },
      ]);

      if (totals.length > 0) {
        balance = totals[0].totalBalance;
        holdAmount = totals[0].totalHoldAmount;
      }

      // Inject totals into user response
      if (existingUser.Wallet) {
        existingUser.Wallet.balance = balance;
        existingUser.Wallet.holdAmount = holdAmount;
      }
    }

    return res.status(200).json({
      success: true,
      user: existingUser,
    });
  } catch (error) {
    console.error("Error in getUserDetails:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};

const changeUser = async (req, res) => {
  try {
    console.log("hi");
    const userId = req.user
      ? req.user.id
      : req.employee
      ? req.employee.id
      : null;
    if (!userId) {
      return res
        .status(401)
        .json({ message: "Unauthorized: user not found in token" });
    }
    const { adminTab } = req.body;
    console.log("ad", adminTab);

    if (typeof adminTab !== "boolean") {
      return res.status(400).json({ message: "Invalid adminTab value" });
    }

    const updatedUser = await User.findByIdAndUpdate(
      userId,
      { adminTab },
      { new: true }
    );

    if (!updatedUser) {
      return res.status(404).json({ message: "User not found" });
    }

    res.status(200).json({
      message: "User tab view updated successfully",
      user: updatedUser,
    });
  } catch (error) {
    console.error("Error updating user adminTab:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};

const getAllPlans = async (req, res) => {
  try {
    const allPlans = await Plan.find({});
    res.status(201).json({
      success: true,
      data: allPlans,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to fetch plans",
      error: error.message,
    });
  }
};

const assignPlan = async (req, res) => {
  try {
    const { userId, userName, planName, rateCards } = req.body;
    console.log(req.body);
    if (!planName || !rateCards) {
      return res
        .status(400)
        .json({ error: "Plan name and rate card are required" });
    }

    // Check if there is an existing plan for the user
    let existingPlan = await Plan.findOne({ userId });

    console.log(existingPlan);

    if (existingPlan) {
      // Update existing plan details (both plan name & rate cards)
      existingPlan.planName = planName;
      existingPlan.rateCard = rateCards;
      existingPlan.assignedAt = new Date(); // Update timestamp

      await existingPlan.save();

      return res
        .status(200)
        .json({ message: "Plan updated successfully", plan: existingPlan });
    }

    // If no existing plan, create a new one
    const newPlan = new Plan({
      userId,
      userName,
      planName,
      rateCard: rateCards,
      assignedAt: new Date(),
    });

    await newPlan.save();

    res
      .status(201)
      .json({ message: "Plan assigned successfully", plan: newPlan });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to assign plan" });
  }
};

const makeAdmin = async () => {
  try {
    const userId = 17333;

    const updatedUser = await User.findOneAndUpdate(
      { userId: userId },
      { isAdmin: true },
      { new: true }
    );

    if (!updatedUser) {
      console.log("❌ User not found");
    } else {
      console.log("✅ User updated to admin:", updatedUser);
    }
  } catch (error) {
    console.error("❌ Error making user admin:", error.message);
  }
};

// makeAdmin();

const getRatecards = async (req, res) => {
  try {
    const { plan: currentPlan } = req.body;

    // Validate input
    if (!currentPlan) {
      return res.status(400).json({
        success: false,
        message: "Plan is required.",
      });
    }

    const rateCard = await RateCard.find({ type: currentPlan });

    if (!rateCard || rateCard.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No rate cards found for the specified plan.",
      });
    }
    res.status(201).json({
      success: true,
      message: "Rate cards retrieved successfully.",
      data: rateCard,
    });
  } catch (error) {
    console.error("Error fetching rate cards:", error);
    res.status(500).json({
      success: false,
      message:
        "An error occurred while fetching rate cards. Please try again later.",
      error: error.message,
    });
  }
};

// Update profile controller
const updateProfile = async (req, res) => {
  try {
    const userId = req.user._id; // Assuming authentication middleware sets this
    const { brandName, website } = req.body;

    let updateData = {
      brandName,
      website,
    };

    // If image uploaded, add profileImage S3 URL
    if (req.file && req.file.location) {
      updateData.profileImage = req.file.location;
    }

    const updatedUser = await User.findByIdAndUpdate(userId, updateData, {
      new: true,
    });

    res.status(200).json({
      message: "Profile updated successfully",
      user: updatedUser,
    });
  } catch (err) {
    console.error("Error updating profile:", err);
    res.status(500).json({ error: "Server error" });
  }
};

const updateReferralCommission = async (req, res) => {
  try {
    const { userId, referralCommissionPercentage } = req.body;
    await User.findByIdAndUpdate(userId, { referralCommissionPercentage });
    res.json({
      success: true,
      message: "Referral commission updated successfully",
    });
  } catch (err) {
    res
      .status(500)
      .json({
        success: false,
        message: "Failed to update referral commission",
      });
  }
}

module.exports = {
  getUsers,
  getUserDetails,
  getAllPlans,
  assignPlan,
  getRatecards,
  getAllUsers,
  changeUser,
  getUserById,
  updateBlockStatus,
  updateProfile,
  updateReferralCommission
};
