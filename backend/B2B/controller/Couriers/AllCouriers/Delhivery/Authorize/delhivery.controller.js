const axios = require("axios");
const AllCourierB2B = require("../../../../../models/AllCourier.model");
const BASE_URL = process.env.DEL_URL;

const getDelhiveryB2BCredentials = async (courierName) => {
  try {
    let courier;
    if (courierName) {
      courier = await AllCourierB2B.findOne({
        courierName: courierName,
        courierProvider: "Delhivery",
      }).lean();
    } else {
      courier = await AllCourierB2B.findOne({
        courierProvider: "Delhivery",
        status: "Enable",
      }).lean();
      if (!courier) {
        courier = await AllCourierB2B.findOne({
          courierProvider: "Delhivery",
        }).lean();
      }
    }

    const username = courier?.username || process.env.DEL_USERNAME_B2B;
    const password = courier?.password || process.env.DEL_PASSWORD_B2B;
    return { username, password };
  } catch (error) {
    console.error("Error fetching Delhivery B2B credentials:", error);
    return {
      username: process.env.DEL_USERNAME_B2B,
      password: process.env.DEL_PASSWORD_B2B,
    };
  }
};

const getToken = async (req, res) => {
  const email = req.body.credentials.username;
  const password = req.body.credentials.password;
  console.log("req data", req.body);

  const courierData = {
    courierName: req.body.courierName,
    courierProvider: req.body.courierProvider,
    CODDays: req.body.CODDays,
    status: req.body.status,
    username: email,
    password: password,
  };

  if (!email || !password) {
    return res.status(400).json({
      message: "Email and password are required.",
    });
  }

  try {
    // Check if an account with the same courierName already exists
    const existingByName = await AllCourierB2B.findOne({ courierName: req.body.courierName });
    if (existingByName) {
      return res.status(400).json({
        message: `Courier account with name '${req.body.courierName}' already exists.`,
      });
    }

    /* ✅ SAVE COURIER */
    const newCourier = new AllCourierB2B(courierData);
    await newCourier.save();

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
 * Refresh Delhivery Cargo Access Token
 */
const refreshToken = async (courierName) => {
  try {
    const { username, password } = await getDelhiveryB2BCredentials(courierName);
console.log("user",username,"pass",password)
    if (!username || !password) {
      throw new Error("Delhivery Cargo username or password missing");
    }

    const response = await axios.post(
      `${BASE_URL}/ums/login`,
      {
        username,
        password,
      },
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    console.log("token", response.data.access);
    return response.data.access;
  } catch (error) {
    console.error(
      "Delhivery Cargo Token Error:",
      error?.response?.data || error.message
    );
    throw error;
  }
};

module.exports = { getToken, refreshToken, getDelhiveryB2BCredentials };
