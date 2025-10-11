const crypto = require("crypto");
const AllCourier = require("../../../models/AllCourierSchema");
const ZIPYPOST_PUBLIC_KEY = process.env.ZIPYPOST_PUBLIC_KEY;
const ZIPYPOST_PRIVATE_KEY = process.env.ZIPYPOST_PRIVATE_KEY;
const ZIPYPOST_SELLER_ID = process.env.ZIPYPOST_SELLER_ID;
const USERNAME = process.env.ZIPYPOST_USERNAME;
const PASSWORD = process.env.ZIPYPOST_PASSWORD;

function getAuthToken() {
  const publicKey = ZIPYPOST_PUBLIC_KEY;
  const privateKey = ZIPYPOST_PRIVATE_KEY;
  const sellerId = ZIPYPOST_SELLER_ID;
  const timestamp = Math.floor(Date.now() / 1000); // current Unix timestamp
  const dataToHash = `public_key=${publicKey}&private_key=${privateKey}&seller_id=${sellerId}&time_stamp=${timestamp}`;

  const authToken = crypto
    .createHmac("sha256", privateKey)
    .update(dataToHash)
    .digest("hex");

  return { authToken, timestamp };
}

// Example usage
// const tokenData = getAuthToken(
//   ZIPYPOST_PUBLIC_KEY,
//   ZIPYPOST_PRIVATE_KEY,
//   ZIPYPOST_SELLER_ID
// );
// console.log("Auth Token:", tokenData.authToken);
// console.log("Timestamp:", tokenData.timestamp);

const saveZipypost = async (req, res) => {
  const { username, password } = req.body.credentials; // Destructure credentials
  const { courierName, courierProvider, CODDays, status } = req.body; // Destructure courier data
  console.log(PASSWORD);

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
    return res.status(500).json({
      message: "Failed to add courier.",
      error: error.message,
    });
  }
};
module.exports = { getAuthToken, saveZipypost };
