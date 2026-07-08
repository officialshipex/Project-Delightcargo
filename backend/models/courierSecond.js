const mongoose = require("mongoose");
const CourierServiceSecond = require("./courierServiceSecond.model");

const courierSecondSchema = new mongoose.Schema(
  {
    provider: {
      type: String,
      required: true,
    },
    services: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CourierServiceSecond',
    }],
    isEnabeled: {
      type: Boolean,
      default: true
    },
    toEnabeled:{
      type:Boolean,
      default:false
    }
  },
  {
    timestamps: true,
  }
);

const CourierSecond = mongoose.model("CourierSecond", courierSecondSchema);
module.exports = CourierSecond;