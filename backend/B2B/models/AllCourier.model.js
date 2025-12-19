const mongoose = require('mongoose');

const allCourierSchema = new mongoose.Schema({
    courierName: {
        type: String,
        required: true,
    },
    courierProvider: {
        type: String,
        required: true,
    },
    CODDays: {
        type: Number,
        required: false,
    },
    status: {
        type: String,
        required: true,
        enum: ["Enable", "Disable"],
      },
    date: {
        type: Date,
        default: Date.now,
    },
});

const AllCourier = mongoose.models.AllCourier || mongoose.model('B2BallCourier', allCourierSchema);
module.exports = AllCourier;
