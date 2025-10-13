const axios = require("axios");
const fs = require("fs");
const csvParser = require("csv-parser");
const path = require("path");
const { fileURLToPath } = require("url");

const METRO_CITIES = [
  "delhi",
  "mumbai",
  "chennai",
  "ahmedabad",
  "kolkata",
  "pune",
  "hyderabad",
  "bangalore",
];

const ZONE_E_STATES = [
  "jammu kashmir",
  "himachal",
  "leh ladakh",
  "andaman nicobar",
  // "kerala",
  "assam",
  "meghalaya",
  "manipur",
  "mizoram",
  "nagaland",
  "tripura",
];

let pinCodeData = {};
const getpinCodeData = async () => {
  const csvFilePath = path.join(__dirname, "../data/pincodes.csv");

  return new Promise((resolve, reject) => {
    fs.createReadStream(csvFilePath)
      .pipe(csvParser())
      .on("data", (row) => {
        if (row.pincode && row.city && row.state) {
          const pincode = row.pincode.trim();
          pinCodeData[pincode] = {
            city: row.city.trim(),
            state: row.state.trim(),
          };
        } else {
          console.log("Invalid CSV row:", row);
        }
      })
      .on("end", () => {
        console.log("CSV file successfully processed");
        resolve();
      })
      .on("error", (error) => {
        console.log("Error while reading CSV file", error);
        reject(error);
      });
  });
};

const getPinCodeDetails = async (pincode) => {
  // console.log("sdssd",pincode)
  //   console.log("Fetching PinCode data...");
  await getpinCodeData();

  pincode = pincode.trim();

  if (pinCodeData[pincode]) {
    // console.log(pinCodeData[pincode]);
    return pinCodeData[pincode];
  }

  try {
    const response = await axios.get(
      `https://api.postalpincode.in/pincode/${pincode}`
    );

    console.log("This is the response of India post api", response.data);

    if (
      response.data &&
      response.data[0].Status === "Success" &&
      response.data[0].PostOffice.length > 0
    ) {
      const pinCodeDetails = response.data[0].PostOffice[0];
      return {
        city: pinCodeDetails.District,
        state: pinCodeDetails.State,
      };
    } else {
      console.log(`No Data found for pincode ${pincode}`);
      return null;
    }
  } catch (error) {
    console.log(
      "API request failed. Server Side Error. Please try after some time later!!",
      error
    );
    return null;
  }
};

const pinCodeCache = new Map(); // In-memory cache

const getPinCodeDetailsCached = async (pinCode) => {
  if (pinCodeCache.has(pinCode)) return pinCodeCache.get(pinCode);
  const details = await getPinCodeDetails(pinCode);
  if (details) pinCodeCache.set(pinCode, details);
  return details;
};

const getZone = async (fromPinCode, toPinCode, res) => {
  if (fromPinCode?.length !== 6 || toPinCode?.length !== 6) {
    return res
      ? res.status(400).json({ message: "Please Enter valid Pincode" })
      : { error: "Please Enter valid Pincode" };
  }

  // ✅ Use cached version
  const fromPinCodeDetails = await getPinCodeDetailsCached(fromPinCode);
  const toPinCodeDetails = await getPinCodeDetailsCached(toPinCode);

  if (!fromPinCodeDetails || !toPinCodeDetails) {
    return res
      ? res.status(400).json({
          message:
            "Pincode details not found, please enter valid pincode or try again later.",
        })
      : {
          error:
            "Pincode details not found, please enter valid pincode or try again later.",
        };
  }

  let fromCity = fromPinCodeDetails.city?.toLowerCase() || "";
  let toCity = toPinCodeDetails.city?.toLowerCase() || "";
  if (fromCity.includes("delhi")) fromCity = "delhi";
  if (toCity.includes("delhi")) toCity = "delhi";

  let fromState = fromPinCodeDetails.state?.toLowerCase() || "";
  let toState = toPinCodeDetails.state?.toLowerCase() || "";

  if (fromCity === toCity) {
    return { zone: "zoneA", details: { fromPinCodeDetails, toPinCodeDetails } };
  }

  if (fromState === toState) {
    return { zone: "zoneB", details: { fromPinCodeDetails, toPinCodeDetails } };
  }

  if (METRO_CITIES.includes(fromCity) && METRO_CITIES.includes(toCity)) {
    return { zone: "zoneC", details: { fromPinCodeDetails, toPinCodeDetails } };
  }

  if (ZONE_E_STATES.includes(toState) || ZONE_E_STATES.includes(fromState)) {
    return { zone: "zoneE", details: { fromPinCodeDetails, toPinCodeDetails } };
  }

  return { zone: "zoneD", details: { fromPinCodeDetails, toPinCodeDetails } };
};

module.exports = { getZone };
