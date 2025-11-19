
const mongoose = require('mongoose');

const aadhaarSchema = new mongoose.Schema({
    user : {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
    aadhaarNumber : {
        type: String,
        required: true,
        unique: true,
    },
    status : {
        type: String,
        // required: true,
    },
    sonOf: {
        type: String,
        // required: true,
    },
    dob : {
        type: String,
        // required: true,
    },
    email : {
        type: String,
    },
    gender : {
        type: String,
        // required: true,
    },
    address : {
        type: String,
        required: true,
    },
    name : {
        type: String,
        required: true,
    },
    state:{
        type:String,
        required:true
    },
    city:{
        type:String,
        required:true
    }
});

const Aadhaar = mongoose.model.Aadhaar || mongoose.model('aadhaar',aadhaarSchema);

module.exports = Aadhaar;