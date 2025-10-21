const mongoose = require("mongoose");
const {rateCardSchema}  = require("./rateCards"); // Assuming RateCard model is here

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
  rateCard: {
    // Make rateCard optional
    type: mongoose.Schema.Types.Mixed, // Allow it to store any object type
    required: false, // Optional
  },
  assignedAt: {
    type: Date,
    default: Date.now,
  },
  priorityType: {
    type: String,
  },
  courierPriority: [
    {
      name: String,
      provider: String,
      mode: String,
    },
  ],
});

const Plan = mongoose.model("Plan", planSchema);
module.exports = Plan;
