if(process.env.NODE_ENV!="production"){
  require('dotenv').config();
  }
const axios = require('axios');

const Courier = require("../../../models/courierSecond");
const AllCourier = require("../../../models/AllCourierSchema");
const url=process.env.NIMBUSPOST_URL;

  const getAuthToken = async (req,res) => {
    const apiKey = req.body.credentials?.apiKey || process.env.NIMBUS_API_KEY || "33b802cb0e1495da1c18bb217f3921a8ac9408a00272530";
    const email = req.body.credentials?.email || process.env.NIMBUSPOST_EMAIL || "nimbuspost@delightcargo.in";
    const password = req.body.credentials?.password || process.env.NIMBUSPOST_PASSWORD || "";

    const CourierData= {
      courierName: req.body.courierName || "NimbusPost",
      courierProvider: req.body.courierProvider || "NimbusPost",
      CODDays: req.body.CODDays || 0,
      status: req.body.status || "Enable",
      email: email,
      password: password,
      apiKey: apiKey
    };

    try {
      let existing = await AllCourier.findOne({ courierProvider: CourierData.courierProvider });
      if (!existing) {
        const newCourier = new AllCourier(CourierData);
        await newCourier.save();
      } else {
        existing.status = CourierData.status;
        existing.email = email;
        existing.password = password;
        existing.apiKey = apiKey;
        await existing.save();
      }

      return res.status(200).json({ message: 'Login successful', token: apiKey });
    }
    catch (error) {
      console.error("Error in authentication:", error);
      return res.status(500).json({ message: `Error in authentication: ${error.message}` });
    }

  }


  const getToken = async ()=>{
    return "33b802cb0e1495da1c18bb217f3921a8ac9408a00272530";
  }





const saveNimbusPost = async (req, res) => {
  try {
    const existingCourier = await Courier.findOne({ provider: 'NimbusPost' });

    if (existingCourier) {
      return res.status(400).json({ message: 'NimbusPost service is already added' });
    }

    const newCourier = new Courier({
      provider: 'NimbusPost'
    });
    await newCourier.save();
    res.status(201).json({ message: 'NimbusPost Integrated Successfully' });
  } catch (error) {
    res.status(500).json({ message: 'An error has occurred', error: error.message });
  }
};

const isEnabeled = async (req, res) => {
  try {
    const existingCourier = await Courier.findOne({ provider: 'NimbusPost' });

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
    const existingCourier = await Courier.findOne({ provider: 'NimbusPost' });

    if (!existingCourier) {
      return res.status(404).json({ isEnabeled: false, message: "Courier not found" });
    }

    existingCourier.isEnabeled = true;
    existingCourier.toEnabeled = false;
    const result = await existingCourier.save();
    return res.status(201).json({ isEnabeled: true, toEnabeled: false });
  }
  catch (error) {
    console.error("Error:", error);
    res.status(500).json({ message: "Internal Server Error" });
  }

}

const disable = async (req, res) => {

  try {
    const existingCourier = await Courier.findOne({ provider: 'NimbusPost' });

    if (!existingCourier) {
      return res.status(404).json({ isEnabeled: false, message: "Courier not found" });
    }

    existingCourier.isEnabeled = true;
    existingCourier.toEnabeled = true;
    const result = await existingCourier.save();
    return res.status(201).json({ isEnabeled: true, toEnabeled: true });
  }
  catch (error) {
    console.error("Error:", error);
    res.status(500).json({ message: "Internal Server Error" });
  }

}



module.exports = { getAuthToken, getToken, saveNimbusPost, isEnabeled, disable ,enable};





