const axios = require("axios");
const AllCourier = require("../../../models/AllCourierSchema");

const PROSHIP_USERNAME = process.env.PROSHIP_USERNAME;
const PROSHIP_PASSWORD = process.env.PROSHIP_PASSWORD;
const PROSHIP_BASE_URL = "https://proship.prozo.com/api";

const getProshipAccessToken = async () => {
  try {
    // console.log("username",PROSHIP_USERNAME);
    // console.log("password",PROSHIP_PASSWORD)
    const response = await axios.post(`${PROSHIP_BASE_URL}/auth/signin`, {
      username: PROSHIP_USERNAME,
      password: PROSHIP_PASSWORD,
    });
    // console.log("response",response.data)
    return response.data.accessToken;
  } catch (error) {
    console.error("Proship Auth Error:", error);
    return null;
  }
};

const saveProship = async (req, res) => {
  const { username, password } = req.body.credentials;
  const { courierName, courierProvider, CODDays, status } = req.body;

  if (PROSHIP_USERNAME !== username || PROSHIP_PASSWORD !== password) {
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
    const newCourier = new AllCourier(courierData);
    await newCourier.save();

        return res.status(201).json({
            message: "Proship courier successfully added.",
            courier: newCourier,
        });
  } catch (error) {
        return res.status(500).json({
            message: "Failed to add Proship courier.",
            error: error.message,
        });
  }
};

module.exports = { saveProship, getProshipAccessToken };
