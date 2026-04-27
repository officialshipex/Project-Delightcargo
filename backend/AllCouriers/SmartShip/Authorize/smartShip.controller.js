require("dotenv").config();
const axios = require("axios");
const AllCourier = require("../../../models/AllCourierSchema");
const USERNAME = process.env.SMARTSHIP_USERNAME;
const PASSWORD = process.env.SMARTSHIP_PASSWORD;
const SMARTSHIP_CLIENT_ID = process.env.SMARTSHIP_CLIENT_ID;
const SMARTSHIP_CLIENT_SECRET = process.env.SMARTSHIP_CLIENT_SECRET;
const getAccessToken = async () => {
  const credentials = {
    username: USERNAME,
    password: PASSWORD, 
    client_id: SMARTSHIP_CLIENT_ID,
    client_secret: SMARTSHIP_CLIENT_SECRET,
    grant_type: "password",
  };
  // console.log("Credentials:", credentials);

  try {
    const response = await axios.post(
      "https://oauth.smartship.in/loginToken.php",
      credentials,
      {
        headers: { "Content-Type": "application/json" },
      }
    );
    // console.log("Access Token:", response.data.access_token);
    return response.data.access_token;
  } catch (error) {
    console.error("Token Error:", error.response?.data || error.message);
    return null;
  }
};

// getAccessToken();

const saveSmartShip = async (req, res) => {
  const { username, password } = req.body.credentials; // Destructure credentials
  const { courierName, courierProvider, CODDays, status } = req.body; // Destructure courier data
  console.log(PASSWORD);

  // Validate if the provided credentials match the expected ones
  if (USERNAME !== username || PASSWORD !== password) {
    return res
      .status(400)
      .json({ message: "Unauthorized access. Invalid credentials." });
  }

  const courierData = {
    courierName,
    courierProvider,
    CODDays,
    status,
    email: username
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

module.exports = { getAccessToken, saveSmartShip };
