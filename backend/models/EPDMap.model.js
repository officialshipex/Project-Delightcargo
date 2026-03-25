const mongoose = require('mongoose');

const EPDMap = new mongoose.Schema({
  courier: { type: String, required: true },
  serviceName: { type: String, required: true },
  cutoffTime: { type: String, required: true, default: "10:00" }, // HH:mm format
}, { timestamps: true });

module.exports = mongoose.model('EPDMap', EPDMap);
