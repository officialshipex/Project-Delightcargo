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
    password: {
        type: String,
        required: false,
    },
    accessKey: {
        // BigShip's login needs a third credential alongside email/password.
        type: String,
        required: false,
    },
    bigshipToken: {
        // Cached bearer token so we don't re-login on every request.
        type: String,
        required: false,
    },
    bigshipTokenExpiringAt: {
        type: Date,
        required: false,
    },
    date: {
        type: Date,
        default: Date.now,
    },
});

const AllCourier = mongoose.models.AllCourier || mongoose.model('allCourier', allCourierSchema);
module.exports = AllCourier;
