const csv = require("csvtojson");
const path = require("path");
const fs = require("fs");

let cache = [];

const loadCSV = async () => {
  if (cache.length) return cache;

  const filePath = path.join(__dirname, "../data/pincodes.csv");

  if (!fs.existsSync(filePath)) {
    console.error("❌ CSV not found:", filePath);
    return [];
  }

  // 🔥 IMPORTANT: delimiter is TAB
  const rows = await csv({
    delimiter: "\t", // <-- THIS IS THE FIX
    trim: true,
  }).fromFile(filePath);

  cache = rows.map((row) => ({
    pincode: String(row.pincode).trim(),
    city: row.city?.trim(),
    state: row.state?.trim(),
  }));

//   console.log("✅ Sample row:", cache[0]);
  return cache;
};

const findByPincode = async (pincode) => {
  const data = await loadCSV();
  return data.find((d) => d.pincode === String(pincode).trim());
};

module.exports = { loadCSV, findByPincode };
