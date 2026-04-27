const mongoose = require('mongoose');

const allCourierSchema = new mongoose.Schema({
    courierName: {
        type: String,
        required: true,
        unique: true,
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
    email: {
        type: String,
        required: false,
    },
    apiKey: {
        type: String,
        required: false,
    },
    date: {
        type: Date,
        default: Date.now,
    },
});

const AllCourier = mongoose.models.AllCourier || mongoose.model('allCourier', allCourierSchema);
module.exports = AllCourier;
