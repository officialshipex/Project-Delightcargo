const mongoose = require("mongoose");

const AllChannel = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  channel:{
    type:String
  },
  storeName: {
    type: String,
    // required: true,
  },
  storeURL: {
    type: String,
    // required: true,
  },
  storeClientId: {
    type: String,
    // required: true,
  },
  storeClientSecret: {
    type: String,
    // required: true,
  },
  storeAccessToken: {
    type: String,
    // required:true
  },
  // Shopify's Client Credentials grant issues a short-lived token (observed
  // ~24h) rather than a permanent one — this tracks when the currently
  // stored storeAccessToken expires so it can be refreshed proactively
  // instead of silently going stale. Not used by WooCommerce.
  storeAccessTokenExpiresAt: {
    type: Date,
  },
  orderSyncFrequency: {
    type: String,
    enum: ["daily", "weekly", "monthly"],
    default: "daily",
  },
  paymentStatus: {
    COD: {
      type: String,
      default: "",
    },
    Prepaid: {
      type: String,
      default: "",
    },
  },
  multiSeller: {
    type: Boolean,
    default: false,
  },
  syncInventory: {
    type: Boolean,
    default: false,
  },
  syncFromDate: {
    type: Date,
    default: null,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  webhookId:{
    type: mongoose.Schema.Types.Mixed
  },
  myshopifyDomain:{
    type: String
  },
  lastSync:{
    type:Date
  }
});

module.exports = mongoose.model("allChannel", AllChannel);
