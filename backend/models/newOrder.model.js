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
  { _id: false }
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
  { _id: false }
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
        quantity: { type: Number, required: true },
        name: { type: String, required: true },
        sku: { type: String },
        unitPrice: { type: String, required: true },
      },
    ],
    packageDetails: {
      deadWeight: { type: Number, required: true },
      applicableWeight: { type: Number, required: true },
      volumetricWeight: {
        length: { type: Number, required: true },
        width: { type: Number, required: true },
        height: { type: Number, required: true },
        calculatedWeight: { type: Number },
      },
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
    label: { type: String },
    shipment_id: { type: String },
    provider: { type: String },
    partner:{type:String},
    totalFreightCharges: { type: Number },
    status: { type: String, required: true },
    ndrStatus: { type: String },
    createdAt: { type: Date, default: Date.now },
    shipmentCreatedAt: { type: Date },
    courierServiceName: { type: String },
    RTOCharges: { type: String },
    COD: { type: String },
    reattempt: { type: Boolean },
    commodityId: { type: Number },
    estimatedDeliveryDate: { type: Date },
    tracking: [
      {
        status: { type: String },
        StatusLocation: { type: String },
        StatusDateTime: { type: Date },
        Instructions: { type: String },
      },
    ],
  },
  { timestamps: true }
);

// Compound index
orderSchema.index({ userId: 1, createdAt: -1 });

const Shipment = mongoose.model("newOrder", orderSchema);

module.exports = Shipment;
