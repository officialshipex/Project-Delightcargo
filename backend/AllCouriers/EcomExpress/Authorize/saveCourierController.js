const AllCourier = require("../../../models/AllCourierSchema");
const ECOMEXPRESS_GMAIL = process.env.ECOMEXPRESS_GMAIL;
const ECOMEXPRESS_PASS = process.env.ECOMEXPRESS_PASS;
const BASE_URL = process.env.ECOMEXPRESS_SERVICE_URL;
const axios = require("axios");
const FormData = require("form-data");
const saveEcomExpress = async (req, res) => {
  const { username, password } = req.body.credentials; // Destructure apiKey from the request body
  const { courierName, courierProvider, CODDays, status } = req.body; // Destructure courier data from the request body

  // Validate if the API token matches the provided apiKey
  if (ECOMEXPRESS_GMAIL !== username || ECOMEXPRESS_PASS !== password) {
    // If the token does not match, return an unauthorized response
    return res
      .status(401)
      .json({ message: "Unauthorized access. Invalid API key." });
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

    // Return a success response with the newly created courier data
    return res.status(201).json({
      message: "Courier successfully added.",
      courier: newCourier,
    });
  } catch (error) {
    // Handle errors gracefully and return a detailed error message
    return res.status(500).json({
      message: "Failed to add courier.",
      error: error.message,
    });
  }
};
const fetchBulkWaybills = async (count) => {
  const url = `${BASE_URL}/services/shipment/products/v2/fetch_awb/`;
  const formData = new FormData();
  formData.append("username", process.env.ECOMEXPRESS_GMAIL); // Replace with actual username
  formData.append("password", process.env.ECOMEXPRESS_PASS); // Replace with actual password
  formData.append("count", "1"); // Number of AWB numbers to fetch
  formData.append("type", "EXPP"); // Type of shipment
  try {
    const response = await axios.post(url, formData, {
      headers: formData.getHeaders(),
    });

    console.log("AWB Response:", response.data);
    return { success: true, awbNumber: response.data };
  } catch (error) {
    console.error("AWB Fetch Error:", error.response?.data || error.message);
    return { success: false, error: error.response?.data || error.message };
  }
};
module.exports = { saveEcomExpress, fetchBulkWaybills };
