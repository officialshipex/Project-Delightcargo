if (process.env.NODE_ENV != "production") {
  require('dotenv').config();
}
const axios = require('axios');

const AllCourier = require("../../../models/AllCourierSchema");


const BASE_URL = process.env.SHREEMA_PRODUCTION_URL;

const saveShreeMaruti = async (req, res) => {
  console.log("I am in shreeMaruti");
  try {
    const existingCourier = await Courier.findOne({ provider: 'ShreeMaruti' });

    if (existingCourier) {
      return res.status(400).json({ message: 'ShreeMaruti service is already added' });
    }

    const newCourier = new Courier({
      provider: 'ShreeMaruti'
    });
    await newCourier.save();
    res.status(201).json({ message: 'ShreeMaruti Integrated Successfully' });
  } catch (error) {
    res.status(500).json({ message: 'An error has occurred', error: error.message });
  }
};


const isEnabeled = async (req, res) => {
  try {
    const existingCourier = await Courier.findOne({ provider: 'ShreeMaruti' });

    if (!existingCourier) {
      return res.status(404).json({ isEnabeled: false, message: "Courier not found" });
    }

    if (existingCourier.isEnabeled && !existingCourier.toEnabeled) {
      return res.status(201).json({ isEnabeled: true, toEnabeled: false });

    } else if (!existingCourier.isEnabeled && existingCourier.toEnabeled) {
      return res.status(201).json({ isEnabeled: false, toEnabeled: true });

    } else if (existingCourier.isEnabeled && existingCourier.toEnabeled) {
      return res.status(201).json({ isEnabeled: true, toEnabeled: true });

    } else {
      return res.status(201).json({ isEnabeled: false, toEnabeled: false });
    }

  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ message: "Internal Server Error" });
  }
};

const enable = async (req, res) => {

  try {
    const existingCourier = await Courier.findOne({ provider: 'ShreeMaruti' });

    if (!existingCourier) {
      return res.status(404).json({ isEnabeled: false, message: "Courier not found" });
    }

    existingCourier.isEnabeled = true;
    existingCourier.toEnabeled = false;
    const result = await existingCourier.save();
    return res.status(201).json({ isEnabeled: true, toEnabeled: false });
  }
  catch (error) {
    onsole.error("Error:", error);
    res.status(500).json({ message: "Internal Server Error" });
  }

}

const disable = async (req, res) => {

  try {
    const existingCourier = await Courier.findOne({ provider: 'ShreeMaruti' });

    if (!existingCourier) {
      return res.status(404).json({ isEnabeled: false, message: "Courier not found" });
    }

    existingCourier.isEnabeled = true;
    existingCourier.toEnabeled = true;
    const result = await existingCourier.save();
    return res.status(201).json({ isEnabeled: true, toEnabeled: true });
  }
  catch (error) {
    onsole.error("Error:", error);
    res.status(500).json({ message: "Internal Server Error" });
  }

}



const getToken = async () => {
  const email = process.env.SHREEMA_PRODUCTION_GMAIL;
  const password = process.env.SHREEMA_PRODUCTION_PASS;
  // console.log(email);
  // console.log(password);
  const vendorType = "SELLER";

  if (!email || !password) {
    throw new Error("Email and password environment variables are required.");
  }

  try {
    const options = {
      method: "POST",
      url: `${BASE_URL}/auth/login`,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      data: { email, password, vendorType },
    };

    const response = await axios.request(options);

    if (response.status === 200 && response.data.data.accessToken) {
      return response.data.data.accessToken;
    } else {
      console.log(`Login failed: ${response.status}`)
      // throw new Error(`Login failed: ${response.status}`);
    }
  } catch (error) {
    // console.error("Response error:", error.response?.data || error.message);
    // throw new Error(`Error in authentication: ${error.message}`);
  }
};

const getAuthToken = async (req, res) => {
  // console.log("hiii")

  const url = `${BASE_URL}/auth/login`;

  const payload = {
    email: req.body.credentials.username,
    password: req.body.credentials.password,
    vendorType: "SELLER"
  };
  console.log(url, payload)
  const courierData = {
    courierName: req.body.courierName,
    courierProvider: req.body.courierProvider,
    CODDays: req.body.CODDays,
    status: req.body.status,
    email: req.body.credentials.username
  }
  try {
    // console.log("hi")
    const response = await axios.post(url, payload, {
      headers: { 'Content-Type': 'application/json' }
    });
    // console.log("hjh",response.data)
    if (response.status) {
      const newCourier = new AllCourier(courierData);
      await newCourier.save();
      res.status(201).json({ message: 'ShreeMaruti Integrated Successfully' });
    }
    else {
      throw new Error(`Login failed: ${response.data.status}`);
    }
  }
  catch (error) {
    // console.log("error",error.response.data).json({ message: error.response.data.message });
    res.status(401).json({ message: error.response.data.message });
    // throw new Error(`Error in authentication: ${error.message}`);
  }

}


module.exports = { saveShreeMaruti, getToken, isEnabeled, disable, enable, getAuthToken };