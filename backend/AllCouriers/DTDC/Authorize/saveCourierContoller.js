if (process.env.NODE_ENV != "production") {
  require("dotenv").config();
}
const axios = require("axios");

const AllCourier = require("../../../models/AllCourierSchema");

const API_TOKEN = process.env.DTDC_API_KEY;
const USERNAME = process.env.DTDC_USERNAME;
const PASSWORD = process.env.DTDC_PASSWORD;
const TOKEN = process.env.DTDC_X_ACCESS_TOKEN;

const getToken = async (req, res) => {
  const { apiKey, username, password, token } = req.body.credentials; // Destructure credentials
  const { courierName, courierProvider, CODDays, status } = req.body; // Destructure courier data
  console.log(PASSWORD);

  // Validate if the provided credentials match the expected ones
  if (
    API_TOKEN !== apiKey ||
    USERNAME !== username ||
    PASSWORD !== password ||
    TOKEN !== token
  ) {
    return res
      .status(400)
      .json({ message: "Unauthorized access. Invalid credentials." });
  }

  const courierData = {
    courierName,
    courierProvider,
    CODDays,
    status,
  };

  try {
    // Create a new courier entry in the database
    const newCourier = new AllCourier(courierData);
    await newCourier.save();

    return res.status(201).json({
      message: "Courier successfully added.",
      courier: newCourier,
    });
  } catch (error) {
    return res.status(500).json({
      message: "Failed to add courier.",
      error: error.message,
    });
  }
};

const saveDtdc = async (req, res) => {
  try {
    const existingCourier = await Courier.findOne({ provider: "Dtdc" });

    if (existingCourier) {
      return res.status(400).json({ message: "Dtdc service is already added" });
    }

    const newCourier = new Courier({
      provider: "Dtdc",
    });
    await newCourier.save();
    res.status(201).json({ message: "Dtdc Integrated Successfully" });
  } catch (error) {
    res
      .status(500)
      .json({ message: "An error has occurred", error: error.message });
  }
};
const DTDC_AUTH_URL =
  "https://blktracksvc.dtdc.com/dtdc-api/api/dtdc/authenticate";
const username = process.env.DTDC_TRACKING_USERNAME;
const password = process.env.DTDC_TRACKING_PASSWORD;

const getDTDCAuthToken = async () => {
  try {
    // Pass username and password as query parameters
    const response = await axios.get(DTDC_AUTH_URL, {
      params: { username, password },
      headers: {
        "Content-Type": "application/json",
      },
    });

    // console.log("DTDC Auth Response:", response.data);
    return response.data;
  } catch (error) {
    // console.error("Error fetching DTDC auth token:", error.message);
    return {
      success: false,
      message: "Failed to authenticate with DTDC",
      error: error.response?.data || error.message,
    };
  }
};
// getDTDCAuthToken();

module.exports = { getToken, saveDtdc, getDTDCAuthToken };
