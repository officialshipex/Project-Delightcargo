if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

const axios = require("axios");
const AllCourier = require("../../../models/AllCourierSchema");

const BASE_URL = `${process.env.SHIPROCKET_URL}/v1/external`;
const SHIPROCKET_EMAIL = process.env.SHIPR_GMAIL;
const SHIPROCKET_PASSWORD = process.env.SHIPR_PASS;

const getAuthToken = async () => {
  try {
    const response = await axios.post(
      `${BASE_URL}/auth/login`,
      { email: SHIPROCKET_EMAIL, password: SHIPROCKET_PASSWORD },
      { headers: { "Content-Type": "application/json" }, timeout: 10000 }
    );
    if (response.data?.token) return response.data.token;
    console.error("ShipRocket getAuthToken: No token in response");
    return null;
  } catch (error) {
    console.error("ShipRocket Auth Error:", error.response?.data || error.message);
    return null;
  }
};

const saveShipRocket = async (req, res) => {
  const { username: email, password } = req.body.credentials;
  const { courierName, courierProvider, CODDays, status } = req.body;

  if (!email || !password) return res.status(400).json({ message: "Email and password are required." });

  try {
    const response = await axios.post(
      `${BASE_URL}/auth/login`,
      { email, password },
      { headers: { "Content-Type": "application/json" }, timeout: 10000 }
    );
    if (!response.data?.token) return res.status(401).json({ message: "Invalid ShipRocket credentials." });
  } catch (error) {
    return res.status(400).json({
      message: "ShipRocket authentication failed.",
      error: error.response?.data?.message || error.message,
    });
  }

  try {
    const newCourier = new AllCourier({
      courierName,
      courierProvider,
      CODDays,
      status,
      email,
    });
    await newCourier.save();
    return res.status(201).json({
      message: "ShipRocket courier successfully added.",
      courier: newCourier,
    });
  } catch (error) {
    return res.status(500).json({
      message: "Failed to save ShipRocket courier.",
      error: error.message,
    });
  }
};

module.exports = { saveShipRocket, getAuthToken };
