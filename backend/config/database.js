const mongoose = require("mongoose");
const dns = require("dns");

// Some networks (mobile carrier DNS in particular) refuse SRV-type DNS
// queries, which the mongodb+srv:// connection string depends on to find
// Atlas's servers — this fails with a querySrv ECONNREFUSED error even
// though the network otherwise works fine. Cloudflare/Google's resolvers
// handle SRV queries correctly, so pin to those instead of whatever DNS
// the OS/network hands out.
dns.setServers(["1.1.1.1", "8.8.8.8"]);

async function connectDB() {
  try {
    // console.log("hii")
    await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 60000,
      maxPoolSize: 10,
      connectTimeoutMS: 10000,
    });

    console.log("✅ Database connected successfully");

    // ── Warm the Delhivery waybill pool on startup ──────────────────────────
    // This pre-fetches 50 waybills per account so the first booking request
    // pops from cache (~2ms) instead of making a live Delhivery API call (~2s).
    // Runs in background — does NOT block server startup.
    if (process.env.NODE_ENV === "production") {
      setImmediate(async () => {
        try {
          const { warmPool } = require("../AllCouriers/Delhivery/Authorize/waybillPool");
          const { getDelhiveryApiKey } = require("../AllCouriers/Delhivery/Authorize/saveCourierContoller");
          const AllCourier = require("../models/AllCourierSchema");

          // Warm pool for every active Delhivery account
          const delhiveryAccounts = await AllCourier.find({
            courierProvider: "Delhivery",
            status: "active",
          }).lean().select("apiKey courierName");

          if (delhiveryAccounts.length === 0) {
            // Fallback: warm with default API key
            const defaultKey = await getDelhiveryApiKey(null);
            await warmPool(defaultKey);
          } else {
            await Promise.all(delhiveryAccounts.map((acc) => warmPool(acc.apiKey)));
          }

          console.log(`✅ [WaybillPool] Warmed ${delhiveryAccounts.length || 1} Delhivery account(s) on startup.`);
        } catch (poolErr) {
          console.error("⚠️ [WaybillPool] Startup warm failed (non-critical):", poolErr.message);
        }
      });
    }
  } catch (err) {
    console.error("❌ Database connection error:", err);
    process.exit(1); // Exit if initial DB connection fails
  }
}

module.exports = connectDB;

