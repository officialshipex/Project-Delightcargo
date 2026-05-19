require("dotenv").config();
const axios = require("axios");
const AllCourier = require("../../../models/AllCourierSchema");
const USERNAME = process.env.EKART_USERNAME;
const PASSWORD = process.env.EKART_PASSWORD;
const EKART_CLIENT_ID = process.env.EKART_CLIENT_ID;
// Map<clientId, { token, expiresAt }>
const ekartTokenCache = new Map();

const getAccessToken = async (courierName) => {
  try {
    let courier;
    if (courierName) {
      courier = await AllCourier.findOne({ 
        courierName: courierName, 
        courierProvider: 'Ekart' 
      });
    }

    // Fallback if not found by name
    if (!courier) {
      courier = await AllCourier.findOne({ 
        courierProvider: 'Ekart', 
        status: 'Enable' 
      });
    }

    const username = courier ? (courier.email || courier.username) : USERNAME;
    const password = courier ? courier.password : PASSWORD;
    const clientId = courier ? courier.apiKey : EKART_CLIENT_ID;

    if (!username || !password || !clientId) {
      console.error("Missing Ekart credentials for:", courierName || "Default");
      return null;
    }

    const now = Date.now();
    const cached = ekartTokenCache.get(clientId);
    if (cached && now < cached.expiresAt) {
      return cached.token;
    }

    const response = await axios.post(
      `https://app.elite.ekartlogistics.in/integrations/v2/auth/token/${clientId}`,
      { username, password },
      { headers: { "Content-Type": "application/json" } }
    );

    if (response.data?.access_token) {
      // Ekart tokens usually last 24 hours. Cache for 12 hours to be safe.
      ekartTokenCache.set(clientId, {
        token: response.data.access_token,
        expiresAt: now + 12 * 60 * 60 * 1000,
      });
      return response.data.access_token;
    }

    return response.data.access_token;
  } catch (error) {
    console.error("Token Error:", error.response?.data || error.message);
    return null;
  }
};

// getAccessToken();

const saveEkart = async (req, res) => {
  const { username, password, clientId } = req.body.credentials;
  const { courierName, courierProvider, CODDays, status } = req.body;

  try {
    const existing = await AllCourier.findOne({ courierName });
    if (existing) {
      return res.status(400).json({ message: `Courier name '${courierName}' already exists.` });
    }

    const courierData = {
      courierName,
      courierProvider,
      CODDays,
      status,
      email: username,
      password,
      apiKey: clientId
    };

    const newCourier = new AllCourier(courierData);
    await newCourier.save();

    return res.status(201).json({
      message: "Ekart account successfully added.",
      courier: newCourier,
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to add Ekart account.", error: error.message });
  }
};

module.exports = { getAccessToken, saveEkart };
