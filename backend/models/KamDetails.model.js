const mongoose = require("mongoose");

const kamDetailsSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    kamName: {
      type: String,
      default: "",
    },

    kamEmail: {
      type: String,
      default: "",
    },

    kamPhone: {
      type: String,
      default: "",
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("KamDetails", kamDetailsSchema);
