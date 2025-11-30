const mongoose = require("mongoose");

const SameDateDeliverySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  deliveryDate: { type: Date, required: true },
  orderDetails: [
    {
      orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order" },
      codAmount: { type: Number },
      customOrderId: { type: String },
    },
  ],
  orderIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Order" }],

  totalCod: { type: Number, required: true },
  status: {
    type: String,
    enum: ["Pending", "Completed"],
    default: "Pending",
  },
});
const SameDateDelivery = mongoose.model(
  "SameDateDelivered",
  SameDateDeliverySchema
);
module.exports = SameDateDelivery;
