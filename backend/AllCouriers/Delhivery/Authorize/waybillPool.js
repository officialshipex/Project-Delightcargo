/**
 * Delhivery Waybill Pool Cache
 * 
 * Pre-fetches waybill numbers from Delhivery API in batches (50 at a time) and
 * stores them in memory. Each shipment booking pops one instantly (~2ms) instead
 * of making a live API call to Delhivery (~7-9 seconds).
 * 
 * - Refills automatically when pool drops below LOW_WATER_MARK
 * - Supports multiple Delhivery accounts (keyed by apiKey)
 * - Safe to use from multiple concurrent requests
 */

const axios = require("axios");

const BATCH_SIZE = 50;         // How many waybills to fetch at once
const LOW_WATER_MARK = 10;     // Trigger refill when pool <= this
const BASE_URL = process.env.DELHIVERY_URL;

// Map<apiKey, string[]>
const pool = new Map();

// Map<apiKey, boolean> — prevents concurrent refills for the same key
const refilling = new Map();

/**
 * Fetch a batch of waybills from Delhivery and add them to the pool.
 */
async function refillPool(apiKey) {
  if (refilling.get(apiKey)) return; // Already refilling
  refilling.set(apiKey, true);

  try {
    const url = `${BASE_URL}/waybill/api/bulk/json/?count=${BATCH_SIZE}`;
    const response = await axios.get(url, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Token ${apiKey || process.env.DEL_API_TOKEN}`,
      },
      timeout: 15000,
    });

    const raw = response.data;
    if (raw) {
      const waybills = String(raw).split(",").map((w) => w.trim()).filter(Boolean);
      const existing = pool.get(apiKey) || [];
      pool.set(apiKey, [...existing, ...waybills]);
      console.log(`✅ [WaybillPool] Refilled ${waybills.length} waybills for key ***${apiKey?.slice(-6)}. Pool size: ${pool.get(apiKey).length}`);
    }
  } catch (err) {
    console.error(`❌ [WaybillPool] Failed to refill for key ***${apiKey?.slice(-6)}:`, err.message);
  } finally {
    refilling.set(apiKey, false);
  }
}

/**
 * Get a single waybill from the pool.
 * If the pool is empty, falls back to a live Delhivery API call.
 * Triggers a background refill when pool is low.
 */
async function getWaybill(apiKey) {
  const key = apiKey || process.env.DEL_API_TOKEN;

  // Ensure pool exists for this key
  if (!pool.has(key)) {
    pool.set(key, []);
  }

  const current = pool.get(key);

  // Pool is empty — must do a live call (rare after initial warmup)
  if (current.length === 0) {
    console.warn(`⚠️ [WaybillPool] Pool empty for key ***${key?.slice(-6)}. Doing live fetch...`);
    try {
      const url = `${BASE_URL}/waybill/api/bulk/json/?count=1`;
      const response = await axios.get(url, {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Token ${key}`,
        },
        timeout: 15000,
      });
      const raw = response.data;
      // Trigger background refill
      setImmediate(() => refillPool(key));
      return raw ? [String(raw).split(",")[0].trim()] : null;
    } catch (err) {
      console.error(`❌ [WaybillPool] Live fetch failed:`, err.message);
      return null;
    }
  }

  // Pop one waybill from front of pool
  const waybill = current.shift();

  // Trigger background refill if pool is getting low
  if (current.length <= LOW_WATER_MARK && !refilling.get(key)) {
    console.log(`ℹ️ [WaybillPool] Pool low (${current.length} left). Refilling in background...`);
    setImmediate(() => refillPool(key));
  }

  return [waybill]; // Return as array to match original fetchBulkWaybills signature
}

/**
 * Pre-warm the pool for a given API key.
 * Call this during server startup for each active Delhivery account.
 */
async function warmPool(apiKey) {
  const key = apiKey || process.env.DEL_API_TOKEN;
  if (!pool.has(key) || pool.get(key).length < LOW_WATER_MARK) {
    console.log(`🔄 [WaybillPool] Warming pool for key ***${key?.slice(-6)}...`);
    await refillPool(key);
  }
}

/**
 * Get current pool stats (for monitoring/debugging).
 */
function getPoolStats() {
  const stats = {};
  for (const [key, waybills] of pool.entries()) {
    stats[`***${key?.slice(-6)}`] = waybills.length;
  }
  return stats;
}

module.exports = { getWaybill, warmPool, getPoolStats };
