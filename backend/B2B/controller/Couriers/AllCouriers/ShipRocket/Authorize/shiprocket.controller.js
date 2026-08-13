const axios = require("axios"); // kept as-is
const AllCourierB2B = require("../../../../../models/AllCourier.model");
const BASE_URL = process.env.B2B_SHIPROCKET_URL; // kept as-is

/**
 * Access tokens are valid ~1 day (per Shiprocket Cargo docs), so we cache the
 * refreshed token in memory and only hit /api/token/refresh/ when it's missing
 * or close to expiry, instead of on every single API call.
 */
let cachedAccessToken = null;
let cachedTokenExpiresAt = 0; // epoch ms
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // refresh 5 min before expiry
const TOKEN_ASSUMED_TTL_MS = 24 * 60 * 60 * 1000; // ~1 day, per docs

// Shiprocket Cargo is a single-account integration (unlike Delhivery, which
// supports multiple named B2B accounts) — there's one enabled courier record
// at most. Falls back to .env if no record has been added yet, so nothing
// breaks for setups that haven't gone through "Add Courier" yet.
const getShiprocketCargoCredentials = async () => {
  try {
    const courier =
      (await AllCourierB2B.findOne({
        courierProvider: "Shiprocket",
        status: "Enable",
      }).lean()) ||
      (await AllCourierB2B.findOne({ courierProvider: "Shiprocket" }).lean());

    return {
      clientId: courier?.clientId || process.env.SHIPROCKET_CARGO_CLIENT_ID,
      refreshTokenValue: courier?.refreshToken || process.env.SHIPROCKET_CARGO_REFRESH_TOKEN,
      authTokenValue: courier?.authToken || process.env.SHIPROCKET_CARGO_AUTH_TOKEN,
    };
  } catch (error) {
    console.error("Error fetching Shiprocket Cargo B2B credentials:", error);
    return {
      clientId: process.env.SHIPROCKET_CARGO_CLIENT_ID,
      refreshTokenValue: process.env.SHIPROCKET_CARGO_REFRESH_TOKEN,
      authTokenValue: process.env.SHIPROCKET_CARGO_AUTH_TOKEN,
    };
  }
};

const getToken = async (req, res) => {
  const { clientId, refreshToken: refreshTokenValue, authToken: authTokenValue } =
    req.body.credentials || {};

  if (!clientId || !refreshTokenValue || !authTokenValue) {
    return res.status(400).json({
      message: "Client ID, Refresh Token, and Auth Token are required.",
    });
  }

  const courierData = {
    courierName: req.body.courierName,
    courierProvider: req.body.courierProvider,
    CODDays: req.body.CODDays,
    status: req.body.status,
    clientId,
    refreshToken: refreshTokenValue,
    authToken: authTokenValue,
  };

  try {
    const existingByName = await AllCourierB2B.findOne({ courierName: req.body.courierName });
    if (existingByName) {
      return res.status(400).json({
        message: `Courier account with name '${req.body.courierName}' already exists.`,
      });
    }

    const newCourier = new AllCourierB2B(courierData);
    await newCourier.save();

    // Drop the cached access token so the very next Shiprocket API call
    // refreshes using these newly-saved credentials instead of whatever
    // (possibly stale/env-based) token was cached before.
    cachedAccessToken = null;
    cachedTokenExpiresAt = 0;

    return res.status(200).json({
      message: "Courier saved successfully",
      courier: newCourier,
    });
  } catch (error) {
    return res.status(500).json({
      message: error.message || "Internal Server Error",
    });
  }
};

/**
 * Refresh Shiprocket Cargo Access Token
 */
const refreshToken = async () => {
  if (cachedAccessToken && Date.now() < cachedTokenExpiresAt - TOKEN_REFRESH_BUFFER_MS) {
    return cachedAccessToken;
  }

  try {
    const { refreshTokenValue, authTokenValue } = await getShiprocketCargoCredentials();
    const REFRESH_TOKEN = refreshTokenValue;
    const AUTH_TOKEN = cachedAccessToken || authTokenValue;

    if (!REFRESH_TOKEN || !AUTH_TOKEN) {
      throw new Error("Shiprocket Cargo AUTH or REFRESH token missing");
    }

    const response = await axios.post(
      `${BASE_URL}/api/token/refresh/`,
      {
        refresh: REFRESH_TOKEN,
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${AUTH_TOKEN}`, // ✅ single Bearer
        },
      }
    );

    cachedAccessToken = response.data.access;
    cachedTokenExpiresAt = Date.now() + TOKEN_ASSUMED_TTL_MS;

  //  console.log("access token",response.data.access)
    return cachedAccessToken;
  } catch (error) {
    console.error(
      "Shiprocket Cargo Token Refresh Error:",
      error?.response?.data || error.message
    );
    throw error;
  }
};
// refreshToken();

module.exports = { getToken, refreshToken, getShiprocketCargoCredentials };
