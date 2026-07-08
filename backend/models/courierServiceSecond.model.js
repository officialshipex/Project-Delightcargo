const mongoose = require("mongoose");
const RateCard = require('./rateCards');

const courierServiceSecondSchema = new mongoose.Schema(
  {
    courierProviderName:{
       type:String,
    },
    courierProviderServiceId: {
      type: String,
      required: true,
    },
    courierProviderServiceName: {
      type: String,
      required: true,
    },
    custom_name:{
      type:String
    },
    rateCards: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'RateCard',
    }],

    provider_courier_id:{
      type:String,
    },
    
    isEnabeled:{
      type:Boolean,
      default:true
    },
    createdName:{
      type:String,
      required:true
    }
  },
  {
    timestamps: true,
  }
);

const CourierServiceSecond= mongoose.model("CourierServiceSecond", courierServiceSecondSchema);
module.exports = CourierServiceSecond;