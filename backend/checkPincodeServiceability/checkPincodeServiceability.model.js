// models/CourierPincode.js
const mongoose = require("mongoose");

const courierPincodeSchema = new mongoose.Schema({
  courier: {
    type: String,
    required: true,
  },
  pincodes: [
    {
      pincode: { type: String, required: true },
      pickup: { type: Boolean, default: false },
      delivery: { type: Boolean, default: false },
      cod: { type: Boolean, default: false },
    },
  ],
}, { timestamps: true });

module.exports = mongoose.model("CourierPincode", courierPincodeSchema);
