// controllers/courierPincodeController.js
const fs = require("fs");
const path = require("path");
const csv = require("fast-csv");
const XLSX = require("xlsx");
const CourierPincode = require("./checkPincodeServiceability.model");

// -----------------------------
// In-memory caches (Optimized)
// -----------------------------
const serviceCache = new Map(); // For quick repeated lookups
const courierPincodesMap = new Map(); // key = courierName, value = { pickupSet, deliverySet, codSet }

// -----------------------------
// Helper: Convert Y/N to boolean
// -----------------------------
const parseYN = (val) => val?.toString().trim().toUpperCase() === "Y";

// -----------------------------
// Load all courier pincodes into memory (called on server start)
// -----------------------------
const loadCourierPincodes = async () => {
  const allCouriers = await CourierPincode.find({})
    .lean()
    .select("courier pincodes");

  for (const c of allCouriers) {
    const pickupSet = new Set();
    const deliverySet = new Set();
    const codSet = new Set();

    for (const p of c.pincodes) {
      if (p.pickup) pickupSet.add(p.pincode.toString());
      if (p.delivery) deliverySet.add(p.pincode.toString());
      if (p.cod) codSet.add(p.pincode.toString());
    }

    courierPincodesMap.set(c.courier, { pickupSet, deliverySet, codSet });
  }

  console.log(`✅ Loaded pincodes for ${courierPincodesMap.size} couriers`);
};

// -----------------------------
// Upload CSV/XLSX
// -----------------------------
const uploadPincode = async (req, res) => {
  try {
    const { courier } = req.params;
    if (!req.file) return res.status(400).json({ message: "File is required" });

    const ext = path.extname(req.file.originalname).toLowerCase();
    let pincodes = [];

    // Parse CSV
    if (ext === ".csv") {
      fs.createReadStream(req.file.path)
        .pipe(
          csv.parse({
            headers: true,
            skipEmptyLines: true,
            trim: true,
            bom: true,
          })
        )
        .on("error", (error) => {
          console.error(error);
          return res.status(500).json({ message: "CSV parsing error" });
        })
        .on("data", (row) => {
          pincodes.push({
            pincode: row.Pincode,
            pickup: parseYN(row.Pickup),
            delivery: parseYN(row.Delivery),
            cod: parseYN(row.Cod),
          });
        })
        .on("end", async () => {
          pincodes = removeDuplicatePincodes(pincodes);
          await saveCourierData(courier, pincodes, req.file.path, res);
        });

      // Parse XLSX
    } else if (ext === ".xlsx") {
      const workbook = XLSX.readFile(req.file.path);
      const sheet = XLSX.utils.sheet_to_json(
        workbook.Sheets[workbook.SheetNames[0]],
        { defval: "" }
      );

      sheet.forEach((row) => {
        pincodes.push({
          pincode: row.Pincode,
          pickup: parseYN(row.Pickup),
          delivery: parseYN(row.Delivery),
          cod: parseYN(row.Cod),
        });
      });

      pincodes = removeDuplicatePincodes(pincodes);
      await saveCourierData(courier, pincodes, req.file.path, res);
    } else {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ message: "Unsupported file type" });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Internal server error" });
  }
};

// -----------------------------
// Helper: Remove duplicate pincodes
// -----------------------------
const removeDuplicatePincodes = (pincodes) => {
  const seen = new Set();
  const unique = [];

  for (const p of pincodes) {
    const pin = p.pincode?.toString().trim();
    if (pin && !seen.has(pin)) {
      seen.add(pin);
      unique.push(p);
    }
  }
  return unique;
};

// -----------------------------
// Save to DB and update in-memory map
// -----------------------------
const saveCourierData = async (courier, pincodes, filePath, res) => {
  try {
    let courierData = await CourierPincode.findOne({ courier });
    if (courierData) courierData.pincodes = pincodes;
    else courierData = new CourierPincode({ courier, pincodes });

    await courierData.save();

    // Build optimized sets for O(1) lookup
    const pickupSet = new Set();
    const deliverySet = new Set();
    const codSet = new Set();

    for (const p of pincodes) {
      const pin = p.pincode?.toString();
      if (p.pickup) pickupSet.add(pin);
      if (p.delivery) deliverySet.add(pin);
      if (p.cod) codSet.add(pin);
    }

    courierPincodesMap.set(courier, { pickupSet, deliverySet, codSet });
    fs.unlinkSync(filePath);

    res.json({
      message: "Pincodes uploaded successfully",
      total: pincodes.length,
    });
  } catch (error) {
    console.error("Error saving courier data:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};

// -----------------------------
// Download CSV
// -----------------------------
const downloadPincode = async (req, res) => {
  try {
    const { courier } = req.params;
    const courierData = await CourierPincode.findOne({ courier });
    if (!courierData)
      return res
        .status(404)
        .json({ message: "No pincodes found for this courier" });

    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=serviceable_pincodes_${courier}.csv`
    );

    const csvStream = csv.format({ headers: true });
    csvStream.pipe(res);

    courierData.pincodes.forEach((p) => {
      csvStream.write({
        Pincode: p.pincode,
        Pickup: p.pickup ? "Y" : "N",
        Delivery: p.delivery ? "Y" : "N",
        Cod: p.cod ? "Y" : "N",
      });
    });

    csvStream.end();
  } catch (err) {
    console.error("Error in downloadPincode:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

// -----------------------------
// Check Pincode Serviceability (O(1) lookup, very fast)
// -----------------------------
const checkPincodeServiceability = (
  pickupPincode,
  courierName,
  deliveryPincode,
  paymentMethod
) => {
  const cacheKey = `${courierName}-${pickupPincode}-${deliveryPincode}-${paymentMethod}`;
  if (serviceCache.has(cacheKey)) return serviceCache.get(cacheKey);

  const courierData = courierPincodesMap.get(courierName);
  if (!courierData) {
    const result = { success: false, reason: "courier_not_found" };
    serviceCache.set(cacheKey, result);
    return result;
  }

  const { pickupSet, deliverySet, codSet } = courierData;

  if (
    !pickupSet.has(pickupPincode.toString()) ||
    !deliverySet.has(deliveryPincode.toString())
  ) {
    const result = { success: false, reason: "not_serviceable" };
    serviceCache.set(cacheKey, result);
    return result;
  }

  if (
    paymentMethod?.toUpperCase() === "COD" &&
    !codSet.has(deliveryPincode.toString())
  ) {
    const result = { success: false, reason: "cod_not_available" };
    serviceCache.set(cacheKey, result);
    return result;
  }

  const result = { success: true };
  serviceCache.set(cacheKey, result);
  return result;
};

const getCourierServiceabilityStats = async (courier) => {
  try {
    if (!courier) throw new Error("Courier name is required");

    const courierData = await CourierPincode.findOne({ courier });
    if (!courierData) throw new Error("Courier not found");

    const { pincodes } = courierData;
    let pickupCount = 0;
    let deliveryCount = 0;
    let codCount = 0;
    let nonServiceableCount = 0;

    for (const p of pincodes) {
      if (p.pickup) pickupCount++;
      if (p.delivery) deliveryCount++;
      if (p.cod) codCount++;
      if (!p.pickup && !p.delivery && !p.cod) nonServiceableCount++;
    }

    return {
      courier,
      totalPincodes: pincodes.length,
      pickupServiceable: pickupCount,
      deliveryServiceable: deliveryCount,
      codServiceable: codCount,
      nonServiceable: nonServiceableCount,
    };
  } catch (error) {
    console.error("Error getting courier stats:", error.message);
    return null; // or throw error if you prefer
  }
};


// (async () => {
//   const stats = await getCourierServiceabilityStats("Dtdc");
//   if (stats) {
//     console.log(stats);
//   } else {
//     console.log("No data found or error occurred");
//   }
// })();


module.exports = {
  uploadPincode,
  downloadPincode,
  checkPincodeServiceability,
  loadCourierPincodes,
};
