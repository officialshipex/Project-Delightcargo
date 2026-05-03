if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}
const axios = require("axios");
const AllCourier = require("../../../models/AllCourierSchema");

const SHADOWFAX_BASE_URL =
  process.env.SHADOWFAX_URL || "https://dale.shadowfax.in/api";

/**
 * Retrieve the Shadowfax API token from DB (by courierName) or from env fallback.
 */
const getShadowfaxToken = async (courierName) => {
  try {
    let courier;
    if (courierName) {
      courier = await AllCourier.findOne({
        courierName,
        courierProvider: "Shadowfax",
      });
    } else {
      courier = await AllCourier.findOne({
        courierProvider: "Shadowfax",
        status: "Enable",
      });
      if (!courier) {
        courier = await AllCourier.findOne({ courierProvider: "Shadowfax" });
      }
    }
    return courier ? courier.apiKey : process.env.SHADOWFAX_TOKEN;
  } catch (error) {
    console.error("Error fetching Shadowfax token:", error.message);
    return process.env.SHADOWFAX_TOKEN;
  }
};

/**
 * POST /Shadowfax/getAuthToken
 * Saves a new Shadowfax courier account to the DB.
 * Body: { courierName, courierProvider, CODDays, status, credentials: { apiKey } }
 */
const getAuthToken = async (req, res) => {
  const { apiKey } = req.body.credentials || {};
  const { courierName, courierProvider, CODDays, status } = req.body;

  if (!apiKey) {
    return res.status(400).json({ message: "API Key (token) is required." });
  }

  try {
    // Prevent duplicate courier name
    const existingByName = await AllCourier.findOne({ courierName });
    if (existingByName) {
      return res.status(400).json({
        message: `Courier account with name '${courierName}' already exists.`,
      });
    }

    // Prevent duplicate API key for this provider
    const existingByKey = await AllCourier.findOne({
      apiKey,
      courierProvider: "Shadowfax",
    });
    if (existingByKey) {
      return res.status(400).json({
        message: "Shadowfax account with this API key already exists.",
      });
    }

    // Validate token against Shadowfax API (serviceability check)
    try {
      await axios.get(
        `${SHADOWFAX_BASE_URL}/v1/clients/serviceability/?service=customer_delivery&page=1&count=1&pincodes=110001`,
        {
          headers: {
            Authorization: `Token ${apiKey}`,
            "Content-Type": "application/json",
          },
          timeout: 10000,
        }
      );
    } catch (validationError) {
      const statusCode = validationError?.response?.status;
      if (statusCode === 401) {
        return res
          .status(401)
          .json({ message: "Invalid Shadowfax API token. Authentication failed." });
      }
      // If other error (network, etc.) we still allow saving — production tokens may have restricted serviceability
      console.warn("Shadowfax token validation warning:", validationError.message);
    }

    const newCourier = new AllCourier({
      courierName,
      courierProvider: "Shadowfax",
      CODDays,
      status,
      apiKey,
    });
    await newCourier.save();

    return res.status(201).json({
      message: "Shadowfax courier added successfully.",
      courier: newCourier,
    });
  } catch (error) {
    console.error("Shadowfax getAuthToken error:", error.message);
    return res.status(500).json({
      message: "Failed to add Shadowfax courier.",
      error: error.message,
    });
  }
};

module.exports = { getAuthToken, getShadowfaxToken };
