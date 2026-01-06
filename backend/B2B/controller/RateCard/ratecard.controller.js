const RateCard = require("../../models/ratecard.model");
const CourierServiceB2B = require("../../models/courierService.model");
const PlanName = require("../../../models/createPlanName.model");
const ZoneMatrix = require("../../models/zoneMatrix.model");
const Audit = require("../../models/ratecardAudit.model");
const Plans = require("../../../models/Plan.model");

const DEFAULT_OVERHEAD_CHARGES = {
  pickupCharge: { type: "percentage", value: 4, min: 0 },
  handlingCharge: { type: "flat", value: 0 },
  codCharges: { type: "percentage", value: 0, min: 0 },
  fodCharges: { type: "flat", value: 0 },
  rovOwner: { type: "percentage", value: 0, min: 70 },
  rovCarrier: { type: "percentage", value: 0, min: 50 },
  odaCharges: { type: "perKg", value: 10, min: 1000 },
  fuelCharge: { type: "percentage", value: 20 },
  docketCharge: { type: "flat", value: 0 },
  appointmentDelivery: { type: "flat", value: 0 },
  greenTax: { type: "flat", value: 0 },
  divisor: { type: "formula", value: 4500 },
  minimumFreight: { type: "flat", value: 220 },
  gst: { type: "percentage", value: 18 },
};

const normalizeOverheadCharges = (incoming = {}) => {
  return {
    ...DEFAULT_OVERHEAD_CHARGES,
    ...incoming,
  };
};

/* ================= META ================= */
exports.getMeta = async (req, res) => {
  const couriers = await CourierServiceB2B.find({ status: "Enable" });
  const plans = await PlanName.find();
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

  if (!card) return res.json(null);

  card.overheadCharges = normalizeOverheadCharges(card.overheadCharges);
  res.json(card);
};

/* ================= CREATE ================= */
exports.createRateCard = async (req, res) => {
  const { courierService, plan, rates, status, overheadCharges } = req.body;

  const exists = await RateCard.findOne({ courierService, plan });
  if (exists) {
    return res.status(409).json({ message: "Rate card already exists" });
  }

  const courier = await CourierServiceB2B.findById(courierService);
  const planData = await PlanName.findById(plan);

  const card = await RateCard.create({
    courierService,
    courierServiceName: courier.name,
    courierProviderName: courier.provider,
    plan,
    planName: planData.name,
    rates,
    overheadCharges: normalizeOverheadCharges(overheadCharges),
    status,
    createdBy: req.user._id,
  });

  const rateCardObject = buildB2BRateCardObject(card);

  // 🔥 REMOVE OLD RATE CARD FOR SAME COURIER (SAFETY)
  await Plans.updateMany(
    {
      planName: planData.name,
      "B2BRateCard.courierService": courierService,
    },
    {
      $pull: {
        B2BRateCard: { courierService },
      },
    }
  );

  // 🔥 PUSH NEW RATE CARD
  await Plans.updateMany(
    { planName: planData.name },
    {
      $push: { B2BRateCard: rateCardObject },
    }
  );

  await Audit.create({
    rateCardId: card._id,
    action: "CREATE",
    newData: card,
    userId: req.user._id,
  });

  res.status(201).json(card);
};

const buildB2BRateCardObject = (card) => ({
  _id: card._id.toString(), // 🔥 CRITICAL FIX
  courierService: card.courierService,
  courierServiceName: card.courierServiceName,
  courierProviderName: card.courierProviderName,
  plan: card.plan,
  planName: card.planName,
  rates: card.rates,
  overheadCharges: card.overheadCharges,
  status: card.status,
  createdAt: card.createdAt,
  updatedAt: card.updatedAt,
});

/* ================= UPDATE ================= */
exports.updateRateCard = async (req, res) => {
  const old = await RateCard.findById(req.params.id);
  if (!old) {
    return res.status(404).json({ message: "Rate card not found" });
  }

  const payload = {
    ...req.body,
    overheadCharges: normalizeOverheadCharges(req.body.overheadCharges),
  };

  const updated = await RateCard.findByIdAndUpdate(req.params.id, payload, {
    new: true,
  });

  const rateCardObject = buildB2BRateCardObject(updated);

  const result = await Plans.updateMany(
    { planName: updated.planName },
    {
      $set: {
        "B2BRateCard.$[rc]": rateCardObject,
      },
    },
    {
      arrayFilters: [{ "rc._id": updated._id.toString() }], // 🔥 STRING MATCH
    }
  );

  // console.log("PLAN UPDATE RESULT:", result);

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
  if (!card) {
    return res.status(404).json({ message: "Rate card not found" });
  }

  await RateCard.findByIdAndDelete(req.params.id);

  // 🔥 IMPORTANT: match STRING _id
  const result = await Plans.updateMany(
    { planName: card.planName },
    { $pull: { B2BRateCard: { _id: card._id.toString() } } }
  );

  // console.log("PLAN DELETE RESULT:", result);

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
  const courier = await CourierServiceB2B.findById(targetCourier);
  const planData = await PlanName.findById(targetPlan);

  const newCard = await RateCard.create({
    courierService: targetCourier,
    courierServiceName: courier.name,
    courierProviderName: courier.provider,
    plan: targetPlan,
    planName: planData.name,
    rates: source.rates,
    overheadCharges: normalizeOverheadCharges(source.overheadCharges),
    status: "active",
    createdBy: req.user._id,
  });

  const rateCardObject = buildB2BRateCardObject(newCard);

  await Plans.updateMany(
    { planName: planData.name },
    { $push: { B2BRateCard: rateCardObject } }
  );

  await Audit.create({
    rateCardId: newCard._id,
    action: "COPY",
    oldData: source,
    newData: newCard,
    userId: req.user._id,
  });

  res.status(201).json(newCard);
};

// Minimum weight   /
// Docket charge
// Fuel charge
// ROV Owner
// ROV Carrier
// ODA Charge
// COD Charges
// To Pay Charges (FOD)
// Handling Charge
// Pickup Charge
// Appointment Delivery Charge
// Green Tax
// Divisor
// Minimum Freight
