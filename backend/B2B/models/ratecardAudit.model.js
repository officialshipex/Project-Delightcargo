const mongoose = require("mongoose");

const RateCardAuditSchema = new mongoose.Schema(
  {
    rateCardId: mongoose.Schema.Types.ObjectId,
    action: String, // CREATE | UPDATE | DELETE | COPY
    oldData: Object,
    newData: Object,
    userId: mongoose.Schema.Types.ObjectId,
  },
  { timestamps: true }
);

module.exports = mongoose.model("B2BRateCardAudit", RateCardAuditSchema);
