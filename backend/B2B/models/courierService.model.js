const mongoose = require("mongoose");

const CourierServiceSchema = new mongoose.Schema({
  provider: {
    type: String,
    required: true,
  },
  courier:{
    type: String,
    // required: true,
  },
  courierType: {
    type: String,
    required: true,
    enum: ["Domestic (Surface)", "Domestic (Air)"],
  },
  name: {
    type: String,
    required: true,
  },
  weight:{
    type: Number,
  },
  status: {
    type: String,
    required: true,
    enum: ["Enable", "Disable"],
  }
}, { timestamps: true });

const CourierService = mongoose.model("B2BCourierService", CourierServiceSchema);
module.exports = CourierService;
