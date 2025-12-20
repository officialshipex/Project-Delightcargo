const axios = require("axios"); // kept as-is
const AllCourierB2B = require("../../../../../models/AllCourier.model");
const BASE_URL = process.env.B2B_SHIPROCKET_URL; // kept as-is

const getToken = async (req, res) => {
  const email = req.body.credentials.username;
  const password = req.body.credentials.password;

  const courierData = {
    courierName: req.body.courierName,
    courierProvider: req.body.courierProvider,
    CODDays: req.body.CODDays,
    status: req.body.status,
  };

  if (!email || !password) {
    return res.status(400).json({
      message: "Email and password are required.",
    });
  }

  try {
    /* 🔐 COMPARE WITH .env CREDENTIALS */
    if (
      email !== process.env.B2B_SHIPROCKET_EMAIL ||
      password !== process.env.B2B_SHIPROCKET_PASSWORD
    ) {
      return res.status(401).json({
        message: "Invalid credentials",
      });
    }

    /* ✅ SAVE COURIER IF MATCHED */
    const newCourier = new AllCourierB2B(courierData);
    await newCourier.save();

    return res.status(200).json({
      message: "Courier saved successfully",
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
  try {
    const REFRESH_TOKEN = process.env.SHIPROCKET_CARGO_REFRESH_TOKEN;
    const AUTH_TOKEN = process.env.SHIPROCKET_CARGO_AUTH_TOKEN;

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

  //  console.log("access token",response.data.access)
    return response.data.access;
  } catch (error) {
    console.error(
      "Shiprocket Cargo Token Refresh Error:",
      error?.response?.data || error.message
    );
    throw error;
  }
};
// refreshToken();

module.exports = { getToken, refreshToken };
