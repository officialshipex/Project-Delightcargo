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
  courierName: {
    type: String,
    required: false,
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
  status: {
    type: String,
    required: true,
    enum: ["Enable", "Disable"],
  }
}, { timestamps: true });

const CourierService = mongoose.model("CourierService", CourierServiceSchema);
module.exports = CourierService;
