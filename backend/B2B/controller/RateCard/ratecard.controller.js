const RateCard = require("../../models/ratecard.model");
const CourierServiceB2B = require("../../models/courierService.model");
const PlanName = require("../../models/createPlanName.model");
const ZoneMatrix = require("../../models/zoneMatrix.model");
const Audit = require("../../models/ratecardAudit.model");
const Plans = require("../../models/plan.model");
const createPlanNameSchema = require("../../models/createPlanName.model");

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
  // console.log("Fetching Rate Card with query:", req.query);
  const { courierId, planId } = req.query;
// console.log("Fetching Rate Card for Courier:", courierId, "Plan:", planId);
  const card = await RateCard.findOne({
    courierService: courierId,
    plan: planId,
  });
  // console.log("Fetched Rate Card:", card);

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
  console.log("Deleting Rate Card:", req.params.id);
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

exports.createPlanName = async (req, res) => {
  try {
    const userId = req.user._id; // Assuming user ID is in req.user from auth middleware
    const { planName } = req.body;

    if (!planName || planName.trim() === "") {
      return res.status(400).json({ message: "Plan name is required" });
    }

    const existing = await createPlanNameSchema.findOne({
      name: planName.trim(),
    });
    if (existing) {
      return res.status(409).json({ message: "Plan already exists" });
    }

    const plan = new createPlanNameSchema({
      name: planName.trim(),
      createdBy: userId, // Save userId here
    });

    await plan.save();
    return res.status(201).json({ message: "Plan created successfully", plan });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Server error" });
  }
};

exports.getPlanNames = async (req, res) => {
  try {
    const plans = await createPlanNameSchema
      .find({}, { name: 1, _id: 0 })
      .sort({ createdAt: -1 }) // Sort by newest first
      .lean();

    const planNames = plans.map((plan) => plan.name);

    return res.status(200).json({ planNames });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Server error" });
  }
};

exports.getRateCardName = async (req, res) => {
  try {
   
    const b2bRateCard = await RateCard.find();
    res.status(200).json({
      message: "Rate cards retrieved successfully",
      B2BRateCard: b2bRateCard
    });
  } catch (err) {
    console.log(err);
    res.status(500).json({ message: "Error retrieving rate cards" }); // Handle errors
  }
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
