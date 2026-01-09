const mongoose = require("mongoose");

// Define the Plan schema
const planSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    ref: "User",
  },
  userName: {
    type: String,
    required: true,
  },
  planName: {
    type: String,
    required: true,
  },
  B2BRateCard: {
    type: mongoose.Schema.Types.Mixed,
    required: false,
  },
  assignedAt: {
    type: Date,
    default: Date.now,
  },
});

const Plan = mongoose.model("B2BPlan", planSchema);
module.exports = Plan;
