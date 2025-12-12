const mongoose = require("mongoose");

const LabelSettingsSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User", // assuming you have a User model
      required: true,
      unique: true,
    },
    showLogoOnLabel: { type: Boolean, default: false },
    useChannelLogo: { type: Boolean, default: false },
    showSupportInfo: { type: Boolean, default: false },
    hideCustomerMobile: { type: Boolean, default: false },
    hideOrderBarcode: { type: Boolean, default: false },

    logoUrl: { type: String }, // base64 or URL (if stored in S3 or elsewhere)

    warehouseSettings: {
      hidePickupAddress: { type: Boolean, default: false },
      hideRTOAddress: { type: Boolean, default: false },
      hideRTOName: { type: Boolean, default: false },
      hidePickupMobile: { type: Boolean, default: false },
      hideRTOMobile: { type: Boolean, default: false },
      hidePickupName: { type: Boolean, default: false },
      hideGstNumber: { type: Boolean, default: false },
    },

    productDetails: {
      hideSKU: { type: Boolean, default: false },
      hideHSN:{type:Boolean,default:false},
      hideQty: { type: Boolean, default: false },
      hideTotalAmount: { type: Boolean, default: false },
      hideOrderAmount: { type: Boolean, default: false },
      hideProduct: { type: Boolean, default: false },
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("LabelSettings", LabelSettingsSchema);
