const mongoose = require("mongoose");

const LocationSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
  },
  { _id: false }
);

const ZoneMatrixSchema = new mongoose.Schema(
  {
    zone: {
      type: String,
      required: true,
      unique: true,   // ✅ only one document per zone
      trim: true,
    },
    locations: {
      type: [LocationSchema],
      default: [],
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("ZoneMatrix", ZoneMatrixSchema);
