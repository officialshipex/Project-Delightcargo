const mongoose = require("mongoose");
const Plan = require("../models/Plan.model");
const Warehouse = require("../models/wareHouse.model");
const Order = require("../models/newOrder.model");
const Wallet = require("./wallet");
const CodPlan = require("../COD/codPan.model");
const usersSchema = new mongoose.Schema(
  {
    fullname: {
      type: String,
      required: true,
    },

    email: {
      type: String,
      unique: true,
      required: true,
    },
    phoneNumber: {
      type: String,
    },
    company: {
      type: String,
    },
    monthlyOrders: {
      type: String,
    },
    password: {
      type: String,
    },
    googleOAuthID: {
      type: String,
    },
    oAuthType: {
      type: Number,
    },
    isVerified: {
      type: Boolean,
      default: false,
    },
    provider: {
      type: String,
      default: "Credentials",
    },
    kycDone: {
      type: Boolean,
      default: false,
    },
    userId: {
      type: Number,
      required: true,
    },
    apiAccess: {
      type: Boolean,
      default: false,
    },
    isBlocked: {
      type: Boolean,
      default: false,
    },
    wareHouse: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Warehouse",
      },
    ],
    plan: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Plan",
    },
    orders: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Order",
      },
    ],
    Wallet: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Wallet",
    },
    isAdmin: {
      type: Boolean,
      default: false,
    },
    adminTab: {
      type: Boolean,
      default: false,
    },
    // ✅ NEW FIELDS
    brandName: {
      type: String,
      default: "",
    },
    website: {
      type: String,
      default: "",
    },
    referralCode: {
      type: String,
      unique: true,
    },
    profileImage: {
      type: String,
      default: "", // This will store the S3 URL
    },
    referredBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    }, // 👈 who referred this user
    referralCommissionPercentage:{
      type: Number,
      default: 0,
    },
    subUserId: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }], // 👈 list of referred users
    lastLogin: { type: Date },
    isPhoneVerified: {
      type: Boolean,
      default: false,
    },
    isEmailVerified: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

usersSchema.pre("save", async function (next) {
  if (this.isNew) {
    try {
      const wallet = new Wallet({
        balance: 0,
        transactions: [],
      });
      const savedWallet = await wallet.save();
      this.Wallet = savedWallet._id;

      const codPlan = new CodPlan({
        user: this._id, // Associate with User
        planName: "D+7", // Default plan
      });

      await codPlan.save();
      next();
    } catch (error) {
      next(error);
    }
  } else {
    next();
  }
});

const User = mongoose.model("User", usersSchema);

module.exports = User;
