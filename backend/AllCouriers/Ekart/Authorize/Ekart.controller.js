require("dotenv").config();
const axios = require("axios");
const AllCourier = require("../../../models/AllCourierSchema");
const USERNAME = process.env.EKART_USERNAME;
const PASSWORD = process.env.EKART_PASSWORD;
const EKART_CLIENT_ID = process.env.EKART_CLIENT_ID;
const getAccessToken = async () => {
  const credentials = {
    username: USERNAME,
    password: PASSWORD,
  };
  console.log("Credentials:", credentials, EKART_CLIENT_ID);
  // const client_id = "EKART_67a48734b43c30b894d7fda2";
  try {
    const response = await axios.post(
      `https://app.elite.ekartlogistics.in/integrations/v2/auth/token/${EKART_CLIENT_ID}`,
      credentials,
      {
        headers: { "Content-Type": "application/json" },
      }
    );
    console.log("Access Token:", response.data.access_token);
    return response.data.access_token;
  } catch (error) {
    console.error("Token Error:", error.response?.data || error.message);
    return null;
  }
};

// getAccessToken();

const saveEkart = async (req, res) => {
  const { username, password } = req.body.credentials; // Destructure credentials
  const { courierName, courierProvider, CODDays, status } = req.body; // Destructure courier data
  //   console.log(req.body.credentials);
  //   console.log(req.body)

  // Validate if the provided credentials match the expected ones
  if (USERNAME !== username || PASSWORD !== password) {
    return res
      .status(401)
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
    console.log(error);
    return res.status(500).json({
      message: "Failed to add courier.",
      error: error.message,
    });
  }
};

module.exports = { getAccessToken, saveEkart };
