const mongoose = require("mongoose");

// Sub-schema for each action in NDR
const ndrActionSchema = new mongoose.Schema(
  {
    action: { type: String, required: true },
    actionBy: { type: String, required: true },
    remark: { type: String },
    source: { type: String },
    date: { type: Date, default: Date.now },
  },
  { _id: false },
);

// Each entry in ndrHistory = array of max 2 actions
const ndrEntrySchema = new mongoose.Schema(
  {
    actions: {
      type: [ndrActionSchema],
      validate: {
        validator: function (arr) {
          return arr.length <= 2;
        },
        message: "Each NDR entry can contain at most 2 actions",
      },
    },
  },
  { _id: false },
);

const orderSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    orderId: {
      type: Number,
      required: true,
    },
    channelId: {
      type: Number,
    },
    channel: {
      type: String,
    },
    storeUrl: {
      type: String,
    },
    pickupAddress: {
      contactName: { type: String, required: true },
      email: { type: String },
      phoneNumber: { type: String, required: true },
      address: { type: String, required: true },
      pinCode: { type: String, required: true },
      city: { type: String, required: true },
      state: { type: String, required: true },
    },
    receiverAddress: {
      contactName: { type: String, required: true },
      email: { type: String },
      phoneNumber: { type: String, required: true },
      address: { type: String, required: true },
      pinCode: { type: String, required: true },
      city: { type: String, required: true },
      state: { type: String, required: true },
    },
    productDetails: [
      {
        id: { type: Number, required: true },
        quantity: { type: Number },
        name: { type: String },
        hsn: { type: String },
        sku: { type: String },
        unitPrice: { type: String },
        category: { type: String },
        discount: { type: String },
        tax: { type: String },
      },
    ],
    packageDetails: {
      deadWeight: { type: Number },
      applicableWeight: { type: Number },
      volumetricWeight: {
        length: { type: Number },
        width: { type: Number },
        height: { type: Number },
        calculatedWeight: { type: Number },
      },
    },
    B2BPackageDetails: {
      applicableWeight: { type: String },
      volumetricWeight: { type: String },
      packages: [
        {
          id: { type: Number },
          noOfBox: { type: Number },
          weightPerBox: { type: Number },
          length: { type: Number },
          width: { type: Number },
          height: { type: Number },
        },
      ],
    },
    orderType: { type: String, enum: ["B2C", "B2B"], default: "B2C" },
    rovType: {
      type: String,
      enum: ["ROV Owner", "ROV Carrier"],
      default: "ROV Owner",
    },
    lrn: { type: String },
    oid: { type: String },
    otherDetails: {
      resellerName: { type: String },
      gstin: { type: String },
      ewaybill: { type: String },
    },
    compositeOrderId: {
      type: String,
      unique: true,
    },
    zone: { type: String },

    paymentDetails: {
      method: { type: String, enum: ["COD", "Prepaid"], required: true },
      amount: { type: Number, required: true },
    },
    rateBreakup: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },

    // Updated ndrHistory
    ndrHistory: {
      type: [ndrEntrySchema],
      default: [],
    },

    ndrReason: {
      date: { type: Date },
      reason: { type: String },
    },

    awb_number: { type: String },
    child_awb_numbers: {
      type: [String],
      default: [],
    },
    label: { type: String },
    manifest: { type: String },
    shipment_id: { type: String },
    provider: { type: String },
    partner: { type: String },
    totalFreightCharges: { type: Number },
    status: { type: String, required: true },
    ndrStatus: { type: String },
    createdAt: { type: Date, default: Date.now },
    shipmentCreatedAt: { type: Date },
    courierServiceName: { type: String },
    RTOCharges: { type: String },
    COD: { type: String },
    reattempt: { type: Boolean, default: false },
    commodityId: { type: Number },
    estimatedDeliveryDate: { type: Date },
    walletDeducted: { type: Boolean, default: false },
    walletRefunded: { type: Boolean, default: false },
    manifestJobId: { type: String },
    invoiceDate: { type: Date },

    tracking: [
      {
        status: { type: String },
        StatusLocation: { type: String },
        StatusDateTime: { type: Date },
        Instructions: { type: String },
      },
    ],
  },
  { timestamps: true },
);

// Compound index
orderSchema.index({ userId: 1, createdAt: -1 });

const Shipment = mongoose.model("newOrder", orderSchema);

module.exports = Shipment;

// 27684
// 19949

// 2000+2500=4500-8600=4100

// 216401000503
