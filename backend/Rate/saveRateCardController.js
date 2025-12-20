const RateCard = require("../models/rateCards");
// const CourierServiceSecond = require("../models/courierServiceSecond.model");
const Plan = require("../models/Plan.model");
const multer = require("multer");
const xlsx = require("xlsx");
const path = require("path");
const fs = require("fs");
const ExcelJS = require("exceljs");
const createPlanNameSchema = require("../models/createPlanName.model");
const Couriers = require("../models/AllCourierSchema");
const CourierService = require("../models/CourierService.Schema");
const PlanName = require("../models/createPlanName.model");
const B2BRateCard = require("../B2B/models/ratecard.model");

const saveRate = async (req, res) => {
  try {
    const {
      plan,
      courierProviderName,
      mode,
      courierServiceName,
      weightPriceBasic,
      weightPriceAdditional,
      codPercent,
      codCharge,
      status,
      shipmentType,
    } = req.body;

    // console.log(weightPriceBasic);
    // console.log(weightPriceAdditional);

    // Fetch users with assigned plans (filtered by planName)
    const usersWithPlans = await Plan.find({ planName: plan });

    // if (!usersWithPlans || usersWithPlans.length === 0) {
    //   return res.status(404).json({
    //     success: false,
    //     message: "No users found with assigned plans",
    //   });
    // }

    // console.log(usersWithPlans);

    // Function to check required fields
    const checkRequiredFields = (weightData) => {
      return weightData.every((weight) => {
        return (
          weight.zoneA !== undefined &&
          weight.zoneB !== undefined &&
          weight.zoneC !== undefined &&
          weight.zoneD !== undefined &&
          weight.zoneE !== undefined
        );
      });
    };

    if (
      !checkRequiredFields(weightPriceBasic) ||
      !checkRequiredFields(weightPriceAdditional)
    ) {
      return res.status(400).json({
        message:
          "Missing required fields for zone rates (e.g. zoneA, zoneB, etc.).",
      });
    }

    // Check if the rate card already exists
    let existingRateCard = await RateCard.findOne({
      plan,
      mode,
      courierProviderName,
      courierServiceName,
    });

    let savedRateCard;

    if (existingRateCard) {
      // Update existing rate card
      existingRateCard.weightPriceBasic = weightPriceBasic;
      existingRateCard.weightPriceAdditional = weightPriceAdditional;
      existingRateCard.codPercent = codPercent;
      existingRateCard.codCharge = codCharge;
      existingRateCard.mode = mode;

      savedRateCard = await existingRateCard.save();

      res.status(201).json({
        message: `${plan} rate card has been updated successfully for service ${courierServiceName} under provider ${courierProviderName}`,
      });
    } else {
      // Create new rate card
      const rcard = new RateCard({
        plan,
        mode,
        courierProviderName,
        courierServiceName,
        weightPriceBasic,
        weightPriceAdditional,
        codPercent,
        codCharge,
        status,
        shipmentType,
        defaultRate: true,
      });

      savedRateCard = await rcard.save();

      // Update courier service with new rate card
      // await CourierServiceSecond.updateOne(
      //   { courierProviderServiceName: courierServiceName },
      //   { $push: { rateCards: savedRateCard } }
      // );

      res.status(201).json({
        message: `${plan} rate card has been added successfully for service ${courierServiceName} under provider ${courierProviderName}`,
      });
    }

    // **Update all users' rateCard field who have the same plan**
    await Plan.updateMany(
      { planName: plan },
      { $push: { rateCard: savedRateCard } }
    );

    console.log(`Updated users with plan "${plan}" to include new rate card`);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Error saving or updating Rate Card" });
  }
};

const getRateCard = async (req, res) => {
  try {
    const allRateCard = await RateCard.find();
    const b2bRateCard = await B2BRateCard.find();
    res.status(200).json({
      message: "Rate cards retrieved successfully",
      rateCards: allRateCard,
      B2BRateCard: b2bRateCard
    });
  } catch (err) {
    console.log(err);
    res.status(500).json({ message: "Error retrieving rate cards" }); // Handle errors
  }
};

const getUsersWithPlans = async (req, res) => {
  try {
    // Fetch all plans with user details
    const usersWithPlans = await Plan.find({});

    if (!usersWithPlans || usersWithPlans.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No users found with assigned plans",
      });
    }
    // console.log(usersWithPlans);

    res.status(200).json({
      success: true,
      data: usersWithPlans,
    });
  } catch (error) {
    console.error("Error fetching users with plans:", error.message);
    res.status(500).json({
      success: false,
      message: "Failed to fetch users with assigned plans",
      error: error.message,
    });
  }
};

// Update Rate Card
const updateRateCard = async (req, res) => {
  try {
    const { id } = req.params;

    // Step 1: Update the main RateCard document
    const updatedRateCard = await RateCard.findByIdAndUpdate(id, req.body, {
      new: true,
      runValidators: true,
    });

    if (!updatedRateCard) {
      return res.status(404).json({ message: "Rate Card not found" });
    }

    // Step 2: Find all plans with the given plan name
    const plans = await Plan.find({ planName: req.body.plan });

    // Step 3: Loop over plans and update matching rateCard object
    for (const plan of plans) {
      let modified = false;

      plan.rateCard = plan.rateCard.map((rc) => {
        if (rc._id.toString() === id) {
          modified = true;
          return {
            ...rc._doc, // existing structure
            ...updatedRateCard.toObject(), // overwrite with new data
          };
        }
        return rc;
      });

      if (modified) {
        await plan.save();
      }
    }

    res.status(200).json({ message: "Rate Card updated in matching plans." });
  } catch (error) {
    console.error("Error updating rate card in plans:", error);
    res.status(500).json({ message: "Server Error", error: error.message });
  }
};

const deleteRateCard = async (req, res) => {
  try {
    const { id } = req.params;

    // Step 1: Delete the RateCard document
    const deletedRateCard = await RateCard.findByIdAndDelete(id);

    if (!deletedRateCard) {
      return res.status(404).json({ message: "Rate Card not found" });
    }

    // Step 2: Find all plans with the same plan name
    const plans = await Plan.find({ planName: deletedRateCard.plan });

    // Step 3: Remove deleted rate card from each plan's rateCard array
    for (const plan of plans) {
      const originalLength = plan.rateCard.length;

      plan.rateCard = plan.rateCard.filter((rc) => rc._id.toString() !== id);

      if (plan.rateCard.length !== originalLength) {
        await plan.save();
      }
    }

    res.status(200).json({
      message: "Rate Card deleted and removed from all matching plans.",
    });
  } catch (error) {
    console.error("Error deleting rate card from plans:", error);
    res.status(500).json({ message: "Server Error", error: error.message });
  }
};

const getRateCardById = async (req, res) => {
  try {
    const { id } = req.params; // Get the ID from the URL
    const rateCard = await RateCard.findById(id); // Fetch the rate card by ID

    if (!rateCard) {
      return res.status(404).json({ message: "Rate Card not found" }); // Return 404 if not found
    }

    res
      .status(200)
      .json({ message: "Rate card retrieved successfully", rateCard }); // Return the found rate card
  } catch (err) {
    console.log(err);
    res.status(500).json({ message: "Error retrieving rate card" }); // Handle any server errors
  }
};

const getPlan = async (req, res) => {
  try {
    const allPlan = await Plan.findOne({ userId: req.user._id });

    if (!allPlan) {
      return res.status(404).json({
        success: false,
        message: "Plan not found for the user.",
      });
    }

    res.status(200).json({
      success: true,
      message: "Plan retrieved successfully.",
      data: allPlan.rateCard, // Sending only rateCard, modify if needed
    });
  } catch (error) {
    console.error("Error fetching plan:", error);
    res.status(500).json({
      success: false,
      message: "Internal Server Error. Please try again later.",
      error: error.message, // Optional, useful for debugging
    });
  }
};

const createPlanName = async (req, res) => {
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

const getPlanNames = async (req, res) => {
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

// const exportDemoRatecard = async (req, res) => {
//   try {
//     const workbook = new ExcelJS.Workbook();
//     const worksheet = workbook.addWorksheet("RateCard Demo");

//     // Define columns for all required rate card fields
//     worksheet.columns = [
//       { header: "Plan Name", key: "planName", width: 20 },
//       {
//         header: "Courier Provider Name",
//         key: "courierProviderName",
//         width: 25,
//       },
//       { header: "Courier Service Name", key: "courierServiceName", width: 25 },
//       // { header: "Mode", key: "mode", width: 15 },
//       // { header: "Status", key: "status", width: 15 },
//       // { header: "Shipment Type", key: "shipmentType", width: 15 },
//       // Basic weights and rates
//       { header: "Basic Weight", key: "basicWeight", width: 15 },
//       { header: "Basic Zone A", key: "basicZoneA", width: 10 },
//       { header: "Basic Zone B", key: "basicZoneB", width: 10 },
//       { header: "Basic Zone C", key: "basicZoneC", width: 10 },
//       { header: "Basic Zone D", key: "basicZoneD", width: 10 },
//       { header: "Basic Zone E", key: "basicZoneE", width: 10 },
//       // Additional weights and rates
//       { header: "Additional Weight", key: "additionalWeight", width: 15 },
//       { header: "Additional Zone A", key: "additionalZoneA", width: 10 },
//       { header: "Additional Zone B", key: "additionalZoneB", width: 10 },
//       { header: "Additional Zone C", key: "additionalZoneC", width: 10 },
//       { header: "Additional Zone D", key: "additionalZoneD", width: 10 },
//       { header: "Additional Zone E", key: "additionalZoneE", width: 10 },
//       // COD
//       { header: "COD Percent", key: "codPercent", width: 15 },
//       { header: "COD Charge", key: "codCharge", width: 15 },
//     ];

//     // Add a demo data row for user reference
//     worksheet.addRow({
//       planName: "Silver (same as existing plans in system)",
//       courierProviderName: "Shipex (same as existing providers in system)",
//       courierServiceName:
//         "Shipex surface (same as existing services in system)",
//       basicWeight: "500 (in grams)",
//       basicZoneA: "50",
//       basicZoneB: "60",
//       basicZoneC: "70",
//       basicZoneD: "80",
//       basicZoneE: "90",
//       additionalWeight: "100 (in grams)",
//       additionalZoneA: "10",
//       additionalZoneB: "12",
//       additionalZoneC: "15",
//       additionalZoneD: "18",
//       additionalZoneE: "20",
//       codPercent: "2",
//       codCharge: "25",
//     });

//     // Set response headers for file download
//     res.setHeader(
//       "Content-Type",
//       "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
//     );
//     res.setHeader(
//       "Content-Disposition",
//       "attachment; filename=ratecard-demo.xlsx"
//     );

//     // Write workbook to response
//     await workbook.xlsx.write(res);
//     res.status(200).end();
//   } catch (error) {
//     console.error("Demo file export error:", error);
//     res.status(500).json({ message: "Error exporting demo file" });
//   }
// };

const exportDemoRatecard = async (req, res) => {
  try {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("RateCard Demo");

    worksheet.columns = [
      { header: "Plan Name", key: "planName", width: 20 },
      {
        header: "Courier Provider Name",
        key: "courierProviderName",
        width: 25,
      },
      { header: "Courier Service Name", key: "courierServiceName", width: 25 },
      { header: "Type", key: "type", width: 10 },
      { header: "Type Text", key: "typeText", width: 15 },
      { header: "weight", key: "weight", width: 12 },
      { header: "zoneA", key: "zoneA", width: 10 },
      { header: "zoneB", key: "zoneB", width: 10 },
      { header: "zoneC", key: "zoneC", width: 10 },
      { header: "zoneD", key: "zoneD", width: 10 },
      { header: "zoneE", key: "zoneE", width: 10 },
      { header: "COD Charge", key: "codCharge", width: 18 },
      { header: "COD_Percentage", key: "codPercentage", width: 15 },
    ];

    // --- First ratecard: Basic and Additional ---
    worksheet.addRow({
      planName: "Silver",
      courierProviderName: "Bluedart",
      courierServiceName: "Bluedart Air",
      type: "1",
      typeText: "Basic",
      weight: "0.5",
      zoneA: "56.00",
      zoneB: "67.00",
      zoneC: "89.00",
      zoneD: "96.00",
      zoneE: "125.00",
      codCharge: "35.4",
      codPercentage: "1.97",
    });

    worksheet.addRow({
      planName: "Silver",
      courierProviderName: "Bluedart",
      courierServiceName: "Bluedart Air",
      type: "2",
      typeText: "Additional",
      weight: "0.5",
      zoneA: "42.40",
      zoneB: "52.40",
      zoneC: "79.00",
      zoneD: "89.00",
      zoneE: "112.00",
      codCharge: "35.4",
      codPercentage: "1.97",
    });

    // --- Add a blank row for visual separation ---
    // worksheet.addRow({});

    // --- Second ratecard: Basic and Additional ---
    worksheet.addRow({
      planName: "Gold",
      courierProviderName: "Xpressbees",
      courierServiceName: "Xpressbees Air",
      type: "1",
      typeText: "Basic",
      weight: "0.5",
      zoneA: "48.00",
      zoneB: "53.00",
      zoneC: "73.00",
      zoneD: "79.00",
      zoneE: "100.00",
      codCharge: "32.78",
      codPercentage: "1.70",
    });

    worksheet.addRow({
      planName: "Gold",
      courierProviderName: "Xpressbees",
      courierServiceName: "Xpressbees Air",
      type: "2",
      typeText: "Additional",
      weight: "0.5",
      zoneA: "43.00",
      zoneB: "46.00",
      zoneC: "61.00",
      zoneD: "67.00",
      zoneE: "83.00",
      codCharge: "32.78",
      codPercentage: "1.70",
    });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=ratecard-demo.xlsx"
    );

    await workbook.xlsx.write(res);
    res.status(200).end();
  } catch (error) {
    console.error("Demo file export error:", error);
    res.status(500).json({ message: "Error exporting demo file" });
  }
};

const uploadRatecard = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    // Read Excel
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(req.file.path);
    const worksheet = workbook.worksheets[0];

    if (!worksheet) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: "No worksheet found" });
    }

    // Get header
    const keys = worksheet
      .getRow(1)
      .values.slice(1)
      .map((k) => String(k).trim());

    // Parse rows, skip empty
    const rows = worksheet
      .getSheetValues()
      .slice(2)
      .filter(
        (r) =>
          r && r.length > 1 && r.some((cell) => cell !== null && cell !== "")
      )
      .map((r) => {
        const obj = {};
        keys.forEach((key, i) => {
          obj[key] = r[i + 1] || "";
        });
        return obj;
      });

    // Delete temp file
    fs.unlink(req.file.path, () => {});

    // Fetch sets for validation
    const [providers, services, plans] = await Promise.all([
      Couriers.find().lean(),
      CourierService.find().lean(),
      PlanName.find().lean(),
    ]);
    const normalize = (str = "") =>
      str
        .trim()
        .replace(/\s+/g, " ")
        .replace(/\u00A0/g, " ")
        .toLowerCase();

    const providerSet = new Set(
      providers.map((p) => normalize(p.courierProvider))
    );
    const serviceSet = new Set(services.map((s) => normalize(s.name)));
    const planSet = new Set(plans.map((p) => normalize(p.name)));

    const errors = [];
    const savedRatecards = [];
    const updatedRatecards = [];
    const toFixedNum = (num) => Number(parseFloat(num || 0).toFixed(2));

    // Group rows by (plan, provider, service)
    const grouped = {};
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 2;

      const plan = normalize(row["Plan Name"]);
      const provider = normalize(row["Courier Provider Name"]);
      const service = normalize(row["Courier Service Name"]);

      if (!planSet.has(plan)) {
        errors.push(`Row ${rowNum}: Invalid Plan`);
        continue;
      }
      if (!providerSet.has(provider)) {
        errors.push(`Row ${rowNum}: Invalid Provider`);
        continue;
      }
      if (!serviceSet.has(service)) {
        errors.push(`Row ${rowNum}: Invalid Service (${service})`);
        continue;
      }

      const key = `${row["Plan Name"]}__${row["Courier Provider Name"]}__${row["Courier Service Name"]}`;
      if (!grouped[key]) {
        grouped[key] = {
          plan: row["Plan Name"],
          courierProviderName: row["Courier Provider Name"],
          courierServiceName: row["Courier Service Name"],
          weightPriceBasic: [],
          weightPriceAdditional: [],
          codCharge: toFixedNum(row["COD Charge"]),
          codPercent: toFixedNum(row["COD_Percentage"]),
        };
      }

      const weightObj = {
        weight: toFixedNum(row["weight"]) * 1000, // kg to grams
        zoneA: toFixedNum(row["zoneA"]),
        zoneB: toFixedNum(row["zoneB"]),
        zoneC: toFixedNum(row["zoneC"]),
        zoneD: toFixedNum(row["zoneD"]),
        zoneE: toFixedNum(row["zoneE"]),
      };

      const type = String(row["Type"] || "").toLowerCase().trim();
      if (type === "basic" || type === "1") {
        grouped[key].weightPriceBasic.push(weightObj);
      } else if (type === "additional" || type === "2") {
        grouped[key].weightPriceAdditional.push(weightObj);
      } else {
        errors.push(
          `Row ${rowNum}: Invalid Type (must be Basic/1 or Additional/2)`
        );
      }
    }

    // Save or update grouped ratecards
    for (const key in grouped) {
      const g = grouped[key];
      const mode = services.find(
        (s) => normalize(s.name) === normalize(g.courierServiceName)
      )?.courierType;

      // Common data structure
      const rateCardData = {
        plan: (g.plan || "").trim(),
        mode: mode || "",
        courierProviderName: (g.courierProviderName || "").trim(),
        courierServiceName: (g.courierServiceName || "").trim(),
        weightPriceBasic: g.weightPriceBasic,
        weightPriceAdditional: g.weightPriceAdditional,
        codCharge: parseFloat(g.codCharge) || 0,
        codPercent: parseFloat(g.codPercent) || 0,
        status: "Active",
        shipmentType: "Forward",
        defaultRate: true,
      };

      // 🔍 Check for existing rate card
      const existing = await RateCard.findOne({
        plan: rateCardData.plan,
        courierProviderName: rateCardData.courierProviderName,
        courierServiceName: rateCardData.courierServiceName,
        shipmentType: "Forward",
      });

      if (existing) {
        // 🟢 Update existing rate card
        Object.assign(existing, rateCardData);
        await existing.save();
        updatedRatecards.push(existing);

        // ✅ Update the Plan with the updated rateCard object
        const planName = rateCardData.plan;

        // If Plan already contains that courier service, replace it
        await Plan.updateMany(
          {
            planName,
            "rateCard.courierServiceName": rateCardData.courierServiceName,
          },
          { $set: { "rateCard.$": existing.toObject() } }
        );

        // If Plan doesn't contain it yet, push it as a new one
        await Plan.updateMany(
          {
            planName,
            "rateCard.courierServiceName": {
              $ne: rateCardData.courierServiceName,
            },
          },
          { $push: { rateCard: existing.toObject() } }
        );
      } else {
        // 🆕 Create new rate card
        const rateCardDoc = new RateCard(rateCardData);
        await rateCardDoc.save();
        savedRatecards.push(rateCardDoc);

        // ✅ Push this new rateCard into Plan
        await Plan.updateMany(
          { planName: rateCardData.plan },
          { $push: { rateCard: rateCardDoc.toObject() } }
        );
      }
    }

    return res.status(200).json({
      message: `Ratecard upload complete. ${savedRatecards.length} new, ${updatedRatecards.length} updated.`,
      savedCount: savedRatecards.length,
      updatedCount: updatedRatecards.length,
      errors,
      data: [...savedRatecards, ...updatedRatecards],
    });
  } catch (err) {
    console.error("Upload ratecard error:", err);
    res.status(500).json({ error: "Failed to upload/process rate card file" });
  }
};

module.exports = {
  saveRate,
  getRateCard,
  getPlan,
  updateRateCard,
  deleteRateCard,
  getRateCardById,
  getUsersWithPlans,
  createPlanName,
  getPlanNames,
  exportDemoRatecard,
  uploadRatecard,
};
