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
const BillingAddress = require("../models/billingInfo.model");
const { generateKeySync } = require("crypto");
const Wallet = require("../models/wallet");

const refundFreightIfSingleDebit = async (orderId) => {
  try {
    if (!orderId) {
      console.log("❌ orderId is required");
      return;
    }

    // 1️⃣ Fetch Order with allowed statuses
    const order = await Order.findOne({
      orderId: orderId,
      status: { $in: ["Booked", "Ready To Ship", "Not Picked"] },
    });

    if (!order) {
      console.log("❌ Order not found or status not eligible");
      return;
    }

    const awb = order.awb_number;
    if (!awb) {
      console.log("❌ Order does not contain awb_number");
      return;
    }

    // 2️⃣ Fetch User
    const user = await User.findById(order.userId);
    if (!user || !user.Wallet) {
      console.log("❌ User or Wallet not found");
      return;
    }

    // 3️⃣ Fetch Wallet
    const wallet = await Wallet.findById(user.Wallet);
    if (!wallet) {
      console.log("❌ Wallet not found");
      return;
    }

    // 4️⃣ Fetch transactions by AWB NUMBER
    const walletTxns = wallet.transactions.filter(
      (txn) => txn.awb_number === awb
    );

    // ---------------------------------------------------------
    // ⭐ NEW LOGIC: If 2 transactions exist → CANCEL ORDER + UPDATE TXNS
    // ---------------------------------------------------------
    if (walletTxns.length === 2) {
      console.log(
        `⚠ Found TWO transactions for AWB ${awb}. Marking CANCELLED.`
      );

      // A) Update Order Status → Cancelled
      order.status = "Cancelled";
      await order.save();

      // B) Update both related wallet transactions
      wallet.transactions = wallet.transactions.map((txn) => {
        if (txn.awb_number === awb) {
          txn.transactionStatus = "Cancelled"; // ← new field
        }
        return txn;
      });

      await wallet.save();

      console.log("✅ Order and Transactions marked as CANCELLED");
      return;
    }

    // ---------------------------------------------------------
    // ⭐ ORIGINAL LOGIC: If only 1 DEBIT → Create CREDIT
    // ---------------------------------------------------------
    if (walletTxns.length === 1 && walletTxns[0].category === "debit") {
      const creditAmount = order.totalFreightCharges;

      if (!creditAmount || creditAmount <= 0) {
        console.log("❌ Invalid freight charge amount");
        return;
      }

      const newBalance = wallet.balance + creditAmount;

      wallet.transactions.push({
        channelOrderId: orderId,
        category: "credit",
        amount: creditAmount,
        balanceAfterTransaction: newBalance,
        awb_number: awb,
        description: "Freight Charges Received",
      });

      wallet.balance = newBalance;
      await wallet.save();

      console.log("✅ Credit transaction added successfully");
      console.log("➡ Updated Wallet Balance:", newBalance);
      return;
    }

    console.log(
      `ℹ No action taken. Existing transactions for AWB ${awb}: ${walletTxns.length}`
    );
  } catch (error) {
    console.error("❌ Refund Freight Error:", error.message);
  }
};

// refundFreightIfSingleDebit(861985)

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

    const parsedLimit = limit === "All" || !limit ? null : Number(limit);
    const skip = parsedLimit ? (Number(page) - 1) * parsedLimit : 0;

    const query = {};

    // --- 🔍 Filter Handling ---
    if (id && id.trim() !== "") {
      query._id = new mongoose.Types.ObjectId(id.trim());
    } else if (userId && userId.trim() !== "") {
      query.userId = Number(userId.trim());
    } else if (search && search.trim() !== "") {
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

    // --- 👨‍💼 Role-based filtering ---
    if (req.employee?.employeeId) {
      const allocations = await AllocateRole.find(
        { employeeId: String(req.employee.employeeId) },
        { sellerMongoId: 1 }
      ).lean();

      const sellerMongoIds = allocations
        .map((a) => a.sellerMongoId)
        .filter(Boolean)
        .map((id) => new mongoose.Types.ObjectId(id));

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

    // --- 🧠 Optimize with projection ---
    const projection = {
      userId: 1,
      fullname: 1,
      email: 1,
      phoneNumber: 1,
      company: 1,
      kycDone: 1,
      creditLimit: 1,
      createdAt: 1,
      lastLogin: 1,
      isBlocked: 1,
      Wallet: 1,
    };

    // --- ⚙️ Parallel fetching of all base data ---
    const [users, verifiedKycCount, pendingKycCount] = await Promise.all([
      User.find(query, projection).populate("Wallet", "balance").lean(),
      User.countDocuments({ ...query, kycDone: true }),
      User.countDocuments({ ...query, kycDone: false }),
    ]);

    if (users.length === 0) {
      return res.status(200).json({
        success: true,
        userIds: [],
        userDetails: [],
        verifiedKycCount,
        pendingKycCount,
        currentPage: Number(page),
        totalPages: 0,
        totalCount: 0,
      });
    }

    const userIds = users.map((u) => u._id);

    // --- 🧩 Fetch related data in parallel ---
    const [plans, codPlans, accounts, aadhars, pans, gsts, orderStats] =
      await Promise.all([
        Plan.find(
          { userId: { $in: userIds } },
          { userId: 1, planName: 1 }
        ).lean(),
        CodPlans.find(
          { user: { $in: userIds } },
          { user: 1, planName: 1 }
        ).lean(),
        Account.find(
          { user: { $in: userIds } },
          {
            user: 1,
            nameAtBank: 1,
            accountNumber: 1,
            ifsc: 1,
            bank: 1,
            branch: 1,
          }
        ).lean(),
        Aadhar.find(
          { user: { $in: userIds } },
          { user: 1, aadhaarNumber: 1, name: 1, state: 1, address: 1 }
        ).lean(),
        Pan.find(
          { user: { $in: userIds } },
          { user: 1, panNumber: 1, nameProvided: 1, pan: 1, panRefId: 1 }
        ).lean(),
        Gst.find(
          { user: { $in: userIds } },
          { user: 1, gstin: 1, address: 1, pincode: 1, state: 1, city: 1 }
        ).lean(),
        Order.aggregate([
          { $match: { userId: { $in: userIds } } },
          {
            $group: {
              _id: "$userId",
              orderCount: { $sum: 1 },
              lastOrderDate: { $max: "$createdAt" },
            },
          },
        ]),
      ]);

    // --- 🗺️ Build maps for quick access ---
    const planMap = new Map(plans.map((p) => [String(p.userId), p]));
    const codMap = new Map(codPlans.map((p) => [String(p.user), p]));
    const accountMap = new Map(accounts.map((a) => [String(a.user), a]));
    const aadharMap = new Map(aadhars.map((a) => [String(a.user), a]));
    const panMap = new Map(pans.map((p) => [String(p.user), p]));
    const gstMap = new Map(gsts.map((g) => [String(g.user), g]));
    const orderStatsMap = new Map(orderStats.map((s) => [String(s._id), s]));

    // --- ⚡ Filter + Paginate efficiently ---
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

    // --- 🧾 Construct final response ---
    const userDetails = paginatedUsers.map((user) => {
      const uid = String(user._id);
      const walletBalance = user.Wallet?.balance || 0;
      const plan = planMap.get(uid);
      const stats = orderStatsMap.get(uid);

      return {
        id: user._id,
        userId: user.userId,
        fullname: user.fullname,
        email: user.email,
        isBlocked: user.isBlocked,
        lastLogin: user.lastLogin,
        phoneNumber: user.phoneNumber,
        company: user.company,
        kycStatus: user.kycDone,
        walletAmount: walletBalance,
        creditLimit: user.creditLimit || 0,
        rateCard: plan?.planName || "N/A",
        codPlan: codMap.get(uid)?.planName || "N/A",
        createdAt: user.createdAt,
        orderCount: stats?.orderCount || 0,
        lastOrderDate: stats?.lastOrderDate || null,
        accountDetails: (() => {
          const acc = accountMap.get(uid);
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
          const a = aadharMap.get(uid);
          if (!a) return null;
          return {
            aadharNumber: a.aadhaarNumber,
            nameOnAadhar: a.name,
            state: a.state,
            address: a.address,
          };
        })(),
        panDetails: (() => {
          const p = panMap.get(uid);
          if (!p) return null;
          return {
            panNumber: p.panNumber,
            nameOnPan: p.nameProvided,
            panType: p.pan,
            referenceId: p.panRefId,
          };
        })(),
        gstDetails: (() => {
          const g = gstMap.get(uid);
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

    // ✅ Same response format as before
    return res.status(200).json({
      success: true,
      userIds: userDetails.map((u) => u.userId),
      userDetails,
      verifiedKycCount,
      pendingKycCount,
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
    const id = req.query.id || req.user._id;

    if (!id) {
      return res
        .status(400)
        .json({ success: false, message: "User ID is required" });
    }

    const user = await User.findById(id)
      .populate("Wallet", "balance holdAmount creditLimit")
      // .select("userId fullname email phoneNumber company kycDone creditLimit createdAt")
      .lean();
    // console.log("user", user);
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    const [plan, codPlan, account, aadhar, pan, gst, billingAddress] =
      await Promise.all([
        Plan.findOne({ userId: user._id }).lean(),
        CodPlans.findOne({ user: user._id }).lean(),
        Account.findOne({ user: user._id }).lean(),
        Aadhar.findOne({ user: user._id }).lean(),
        Pan.findOne({ user: user._id }).lean(),
        Gst.findOne({ user: user._id }).lean(),
        BillingAddress.findOne({ user: user._id }).lean(),
      ]);

    const walletBalance = user.Wallet?.balance || 0;
    const holdAmount = user.Wallet?.holdAmount;

    const userDetails = {
      id: user._id,
      userId: user.userId,
      fullname: user.fullname,
      email: user.email,
      phoneNumber: user.phoneNumber,
      company: user.company,
      kycStatus: user.kycDone,
      walletAmount: walletBalance,
      isEmailVerified: user.isEmailVerified,
      isPhoneVerified: user.isPhoneVerified,
      holdAmount: holdAmount,
      creditLimit: user.Wallet?.creditLimit || 0,
      rateCard: plan?.planName || "N/A",
      codPlan: codPlan?.planName || "N/A",
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      isBlocked: user.isBlocked,
      adminApiAccess: user.adminApiAccess,
      apiAccess: user.apiAccess,
      logo: user.profileImage || "",
      referralCode: user.referralCode || "",
      lastLogin: user.lastLogin,
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
      billingAddress: billingAddress,
    };
    // console.log(userDetails);

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

async function generateWalletReport() {
  try {
    // 1️⃣ Fetch Users and Wallet IDs they reference
    const users = await User.find({}, { Wallet: 1 });
    const usedWalletIds = users
      .filter((u) => u.Wallet)
      .map((u) => u.Wallet.toString());

    // 2️⃣ Fetch all Wallets
    const allWallets = await Wallet.find({});
    const allWalletIds = allWallets.map((w) => w._id.toString());

    console.log("\n==================== WALLET REPORT ====================");

    console.log(`👤 Total Users: ${users.length}`);
    console.log(`👜 Total Wallets in DB: ${allWalletIds.length}`);
    console.log(`🔗 Wallets referenced by Users: ${usedWalletIds.length}`);

    // 3️⃣ Orphan wallets (not linked to user)
    const orphanWallets = allWallets.filter(
      (w) => !usedWalletIds.includes(w._id.toString())
    );

    console.log(`❗ Orphan Wallets (no user linked): ${orphanWallets.length}`);

    // 4️⃣ Duplicate wallet references
    const walletCountMap = {};
    users.forEach((u) => {
      if (u.Wallet) {
        const wid = u.Wallet.toString();
        walletCountMap[wid] = (walletCountMap[wid] || 0) + 1;
      }
    });

    const duplicateWallets = Object.entries(walletCountMap)
      .filter(([wid, count]) => count > 1)
      .map(([wid, count]) => ({ walletId: wid, userCount: count }));

    console.log(
      `⚠ Duplicate Wallet IDs (shared by multiple users): ${duplicateWallets.length}`
    );

    // 5️⃣ Users missing wallet assignment
    const usersWithoutWallet = users.filter((u) => !u.Wallet);

    console.log(
      `🚫 Users without wallet assigned: ${usersWithoutWallet.length}`
    );

    // 6️⃣ Filter SAFE orphan wallets that CAN be deleted
    const safeToDeleteOrphans = orphanWallets.filter((w) => {
      return (
        (w.balance || 0) === 0 &&
        (w.holdAmount || 0) === 0 &&
        (!w.transactions || w.transactions.length === 0) &&
        (!w.walletHistory || w.walletHistory.length === 0)
      );
    });

    console.log(
      `\n🟢 Safe orphan wallets to delete (zero amount + no history): ${safeToDeleteOrphans.length}`
    );

    console.log(
      "Wallet IDs to be deleted:",
      safeToDeleteOrphans.map((w) => w._id.toString())
    );

    // 7️⃣ DELETE ONLY safe orphan wallets
    const deleteResult = await Wallet.deleteMany({
      _id: { $in: safeToDeleteOrphans.map((w) => w._id) },
    });

    console.log(
      `\n🗑 Deleted Wallet Count: ${deleteResult.deletedCount} (only safe orphans)`
    );

    console.log("\n==================== END REPORT ====================\n");
  } catch (err) {
    console.error("❌ Error generating report:", err);
  }
}

// Run the function
// generateWalletReport();

const updateApiAccess = async (req, res) => {
  try {
    const { userId: bodyUserId, apiAccess, adminApiAccess } = req.body;

    // If userId is provided in body → update apiAccess
    // If userId is not provided → use req.user._id and update adminApiAccess
    const targetUserId = bodyUserId || req.user?._id;

    if (!targetUserId) {
      return res.status(400).json({ message: "User ID is required" });
    }

    // Fetch user
    const user = await User.findById(targetUserId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Condition 1: userId comes from req.body → update apiAccess
    if (bodyUserId) {
      user.adminApiAccess = adminApiAccess;
    }

    // Condition 2: userId comes from req.user → update adminApiAccess
    if (!bodyUserId && req.user) {
      user.apiAccess = apiAccess;
    }

    await user.save();

    return res.status(200).json({
      success: true,
      message: bodyUserId
        ? `API Access has been ${
            apiAccess ? "enabled" : "disabled"
          } successfully.`
        : `Admin API Access has been ${
            adminApiAccess ? "enabled" : "disabled"
          } successfully.`,
      user,
    });
  } catch (error) {
    console.error("Error updating API access:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error while updating API access.",
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
    res.status(500).json({
      success: false,
      message: "Failed to update referral commission",
    });
  }
};

const updateCreditLimit = async (req, res) => {
  try {
    const { userId, creditLimit } = req.body;

    if (!userId || creditLimit === undefined) {
      return res.status(400).json({
        success: false,
        message: "userId and creditLimit are required",
      });
    }

    // ---- Fetch User ----
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    if (!user.Wallet) {
      return res.status(400).json({
        success: false,
        message: "Wallet not linked to this user",
      });
    }

    // ---- Fetch Wallet ----
    const wallet = await Wallet.findById(user.Wallet);
    if (!wallet) {
      return res.status(404).json({
        success: false,
        message: "Wallet not found",
      });
    }

    // ---- Update Credit Limit ----
    wallet.creditLimit = creditLimit;
    await wallet.save();

    return res.status(200).json({
      success: true,
      message: "Credit limit updated successfully",
      creditLimit: wallet.creditLimit,
    });
  } catch (error) {
    console.error("Update Credit Limit Error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal Server Error",
    });
  }
};

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
  updateApiAccess,
  updateProfile,
  updateReferralCommission,
  updateCreditLimit,
};
