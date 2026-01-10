const mongoose = require('mongoose');

const bulkOrdersFileSchema = new mongoose.Schema({
    filename: {
        type: String,
        required: true,
    },
    date: {
        type: Date,
        default: Date.now,
    },
    status: {
        type: String,
        enum: ['Processing', 'Completed',"Partial", 'Error'],
        default: 'Processing',
    },
    noOfOrders: {
        type: Number,
        default: 0,
    },
    successfullyUploaded: {
        type: Number,
        default: 0,
    },
    errorOrders: {
        type: Number,
        default: 0,
    },
});

const BulkOrderFiles = mongoose.model('BulkOrderFiles', bulkOrdersFileSchema);
module.exports = BulkOrderFiles;
