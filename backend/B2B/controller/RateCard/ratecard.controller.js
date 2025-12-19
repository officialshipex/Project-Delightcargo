const RateCard = require("../../models/ratecard.model");
const CourierServiceB2B = require("../../models/courierService.model");
const Plan = require("../../../models/createPlanName.model");
const ZoneMatrix = require("../../models/zoneMatrix.model");
const Audit = require("../../models/ratecardAudit.model");

/* ================= META ================= */
exports.getMeta = async (req, res) => {
  const couriers = await CourierServiceB2B.find({ status: "Enable" });
  const plans = await Plan.find();
  const zones = await ZoneMatrix.find().select("zone -_id");

  res.json({
    couriers,
    plans,
    zones: zones.map((z) => z.zone),
    statuses: ["active", "inactive"],
  });
};

/* ================= GET ================= */
exports.getRateCard = async (req, res) => {
  const { courierId, planId } = req.query;

  const card = await RateCard.findOne({
    courierService: courierId,
    plan: planId,
  });

  res.json(card || null);
};

/* ================= CREATE ================= */
exports.createRateCard = async (req, res) => {
  const { courierService, plan, rates, status,overheadCharges } = req.body;

  const exists = await RateCard.findOne({ courierService, plan });
  if (exists)
    return res.status(409).json({ message: "Rate card already exists" });
  const courierServiceB2B = await CourierServiceB2B.findById(courierService);
  const planData = await Plan.findById(plan);

  const card = await RateCard.create({
    courierService,
    courierServiceName: courierServiceB2B.name,
    plan,
    planName: planData.name,
    rates,
    overheadCharges,
    status,
    createdBy: req.user._id,
  });

  await Audit.create({
    rateCardId: card._id,
    action: "CREATE",
    newData: card,
    userId: req.user._id,
  });

  res.status(201).json(card);
};

/* ================= UPDATE ================= */
exports.updateRateCard = async (req, res) => {
  const old = await RateCard.findById(req.params.id);

  const updated = await RateCard.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
  });

  await Audit.create({
    rateCardId: updated._id,
    action: "UPDATE",
    oldData: old,
    newData: updated,
    userId: req.user._id,
  });

  res.json(updated);
};

/* ================= DELETE ================= */
exports.deleteRateCard = async (req, res) => {
  const card = await RateCard.findById(req.params.id);

  await RateCard.findByIdAndDelete(req.params.id);

  await Audit.create({
    rateCardId: card._id,
    action: "DELETE",
    oldData: card,
    userId: req.user._id,
  });

  res.json({ success: true });
};

/* ================= COPY ================= */
exports.copyRateCard = async (req, res) => {
  const { sourceId, targetCourier, targetPlan } = req.body;

  const source = await RateCard.findById(sourceId);
   const courierServiceB2B = await CourierServiceB2B.findById(targetCourier);
  const planData = await Plan.findById(targetPlan);

  const newCard = await RateCard.create({
    courierService: targetCourier,
    courierServiceName: courierServiceB2B.name,
    plan: targetPlan,
    planName: planData.name,
    rates: source.rates,
    overheadCharges: source.overheadCharges,
    status: "active",
    createdBy: req.user._id,
  });

  await Audit.create({
    rateCardId: newCard._id,
    action: "COPY",
    oldData: source,
    newData: newCard,
    userId: req.user._id,
  });

  res.status(201).json(newCard);
};
