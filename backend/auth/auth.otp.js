const express = require("express");
const axios = require("axios");
const otpRouter = express.Router();
const User = require("../models/User.model");
const { isAuthorized } = require("../middleware/auth.middleware");

// Store OTPs temporarily (in-memory for simplicity)
const otpStore = {};

// Generate OTP
const generateOtp = () =>
  Math.floor(100000 + Math.random() * 900000).toString();

// Send OTP via YourBulkSMS API
otpRouter.post("/send-otp", async (req, res) => {
  const { phoneNumber } = req.body;

  if (!phoneNumber) {
    return res
      .status(400)
      .json({ success: false, message: "Phone number required" });
  }

  // Check if email already exists and is verified
  const existingUser = await User.findOne({ phoneNumber });

  if (existingUser && existingUser.isPhoneVerified === true) {
    return res.status(400).json({
      success: false,
      message: "Phone No already exists",
    });
  }

  const otp = generateOtp();
  otpStore[phoneNumber] = otp; // Save OTP against the phone number

  try {
    console.log(`Sending OTP to ${phoneNumber}: ${otp}`);

    const response = await axios.get(
      "http://control.yourbulksms.com/api/sendhttp.php?",
      {
        params: {
          authkey: "3632686970657834343532", // Replace with actual API key
          mobiles: phoneNumber,
          message: `Your Application Verification Code is ${otp} IBITTS`,
          sender: "IBITTS",
          route: "2",
          country: "0",
          // DLT_TE_ID: "1707168482954578613",
          DLT_TE_ID: "1707168499016611106",
        },
      }
    );

    console.log("YourBulkSMS Response:", response.data);

    // ✅ Correct response handling
    if (response.data.Status === "Success") {
      return res.status(200).json({
        success: true,
        message: "OTP sent successfully",
        data: response.data,
        otp: otp,
      });
    } else {
      console.error("Failed OTP API Response:", response.data);
      return res.status(500).json({
        success: false,
        message: "Failed to send OTP",
        data: response.data,
      });
    }
  } catch (error) {
    console.error(
      "Error sending OTP:",
      error.response ? error.response.data : error.message
    );
    return res.status(500).json({
      success: false,
      message: "Internal Server Error",
      error: error.message,
    });
  }
});

// Verify OTP
otpRouter.post("/verify-otp", isAuthorized, async (req, res) => {
  try {
    const { phoneNumber, otp } = req.body;
    const id = req.user._id;

    // Validate input
    if (!phoneNumber || !otp) {
      return res
        .status(400)
        .json({ success: false, message: "phoneNumber and otp are required" });
    }

    // Check OTP validity
    if (!otpStore[phoneNumber] || otpStore[phoneNumber] !== otp) {
      return res.status(400).json({ success: false, message: "Invalid OTP" });
    }

    // Find user
    const user = await User.findById(id);
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    // Update user's phone and verification status
    user.phoneNumber = phoneNumber;
    user.isPhoneVerified = true;
    await user.save();

    // Remove OTP after verification
    delete otpStore[phoneNumber];

    res.status(200).json({
      success: true,
      message: "Phone number verified successfully",
      user,
    });
  } catch (error) {
    console.error("Error verifying phone OTP:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = otpRouter; // Export the OTP routes
