const axios = require("axios"); // kept as-is
const AllCourierB2B = require("../../../../../models/AllCourier.model");
const BASE_URL = process.env.DEL_URL; // kept as-is

const getToken = async (req, res) => {
  const email = req.body.credentials.username;
  const password = req.body.credentials.password;
console.log("req data",req.body)
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
      email !== process.env.DEL_USERNAME_B2B ||
      password !== process.env.DEL_PASSWORD_B2B
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
    const USERNAME = process.env.DEL_USERNAME_B2B;
    const PASSWORD = process.env.DEL_PASSWORD_B2B;

    if (!USERNAME || !PASSWORD) {
      throw new Error("Delhivery Cargo username or password missing");
    }

    const response = await axios.post(
      `${BASE_URL}/ums/login`,
      {
        username: USERNAME,
        password: PASSWORD,
      },
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

     console.log("token",response.data.access)
    return response.data.access;
  } catch (error) {
    console.error(
      "Delhivery Cargo Token Error:",
      error?.response?.data || error.message
    );
    // throw error;
  }
};
// refreshToken();

module.exports = { getToken, refreshToken };
