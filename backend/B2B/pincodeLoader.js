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

// Powers the Zone Matrix "search by city, state, or pincode" box — one
// query field, matched against whichever of the three it looks like.
// Returns ready-to-add suggestions: `name` is what actually gets added as
// a zone location (a city or state name — never a bare pincode, which
// isn't meaningful to match orders against), `label`/`detail` are just for
// display so the user can tell what they're picking.
const searchLocations = async (query, limit = 20) => {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return [];

  const data = await loadCSV();
  const isPincodeQuery = /^\d+$/.test(q);

  const pincodeMatches = [];
  const cityMatches = new Map(); // dedupe by "city|state"
  const stateMatches = new Map(); // dedupe by state name (case-insensitive)

  for (const row of data) {
    if (!row.city || !row.state) continue;
    const cityLower = row.city.toLowerCase();
    const stateLower = row.state.toLowerCase();

    if (isPincodeQuery && pincodeMatches.length < limit && row.pincode.startsWith(q)) {
      pincodeMatches.push({
        label: "Pincode",
        name: row.city,
        detail: `${row.pincode} · ${row.state}`,
      });
    }

    if (!isPincodeQuery && cityLower.includes(q)) {
      const key = `${cityLower}|${stateLower}`;
      if (!cityMatches.has(key)) {
        cityMatches.set(key, { label: "City", name: row.city, detail: row.state });
      }
    }

    if (!isPincodeQuery && stateLower.includes(q) && !stateMatches.has(stateLower)) {
      stateMatches.set(stateLower, { label: "State", name: row.state, detail: null });
    }
  }

  // Prefix matches read as more relevant than the query just appearing
  // somewhere inside the name — surface those first within each group.
  const byPrefixFirst = (a, b) => {
    const aPrefix = a.name.toLowerCase().startsWith(q) ? 0 : 1;
    const bPrefix = b.name.toLowerCase().startsWith(q) ? 0 : 1;
    return aPrefix - bPrefix || a.name.localeCompare(b.name);
  };

  const cities = [...cityMatches.values()].sort(byPrefixFirst).slice(0, limit);
  const states = [...stateMatches.values()].sort(byPrefixFirst).slice(0, limit);

  return [...pincodeMatches, ...states, ...cities].slice(0, limit);
};

module.exports = { loadCSV, findByPincode, searchLocations };
