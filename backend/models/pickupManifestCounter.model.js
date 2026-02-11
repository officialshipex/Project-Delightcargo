const mongoose = require("mongoose");

const pickupManifestCounterSchema = new mongoose.Schema({
  date: {
    type: String, // YYYY-MM-DD
    required: true,
    unique: true,
  },
  seq: {
    type: Number,
    default: 111111,
  },
});

module.exports = mongoose.model(
  "PickupManifestCounter",
  pickupManifestCounterSchema
);
