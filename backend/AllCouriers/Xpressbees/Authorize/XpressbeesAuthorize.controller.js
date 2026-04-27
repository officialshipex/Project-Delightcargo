if(process.env.NODE_ENV!="production"){
  require('dotenv').config();
}


const AllCourier=require("../../../models/AllCourierSchema");
const axios=require("axios");

const BASE_URL=process.env.XpreesbeesUrl;


const getAuthToken = async (req,res) => {

    const url = `${BASE_URL}/api/users/login`;
    const payload = {
         email:req.body.credentials.email,
         password:req.body.credentials.password
    };
    const courierData= {
      courierName: req.body.courierName,
      courierProvider: req.body.courierProvider,
      CODDays: req.body.CODDays,
      status:req.body.status,
      email:req.body.credentials.email
    }
    try {
      // console.log("hi")
        const response = await axios.post(url, payload, {
            headers: { 'Content-Type': 'application/json' }
        });
        console.log("hjh",response.data)
        if (response.data.status) {
            const newCourier = new AllCourier(courierData);
            await newCourier.save();
            res.status(201).json({ message: 'Xpressbees Integrated Successfully' });
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



const saveXpressbees = async (req, res) => {
    try {
        const existingCourier = await Courier.findOne({ provider: 'Xpressbees' });

        if (existingCourier) {
            return res.status(400).json({ message: 'Xpressbees service is already added' });
        }

        const newCourier = new Courier({
            provider: 'Xpressbees'
        });
        await newCourier.save();
        res.status(201).json({ message: 'Xpressbees Integrated Successfully' });
    } catch (error) {
        res.status(500).json({ message: 'An error has occurred', error: error.message });
    }
};

const isEnabeled = async (req, res) => {
  try {
    const existingCourier = await Courier.findOne({ provider:'Xpressbees'});

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
      const existingCourier = await Courier.findOne({ provider:'Xpressbees'});
  
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
      const existingCourier = await Courier.findOne({ provider: 'Xpressbees'});
  
      if (!existingCourier) {
        return res.status(404).json({ isEnabeled: false, message: "Courier not found" });
      }
  
      existingCourier.isEnabeled = true;
      existingCourier.toEnabeled = true;
      const result=await existingCourier.save();
      return res.status(201).json({ isEnabeled: true, toEnabeled:true});
    }
    catch (error) {
      onsole.error("Error:", error);
      res.status(500).json({ message: "Internal Server Error" });
    }
  
  }


  const getToken = async ()=>{
  
      const payload ={
        email: process.env.XpreesbeesEmail,
        password:process.env.XpressbeesPassword
        
      };
      const url = `${BASE_URL}/api/users/login`;
      try {
        
        const response = await axios.post(url, payload, {
          headers: { 'Content-Type': 'application/json' }
        });
        return response.data.data
  
      } catch (error) {
          console.log(error)
      }
    }
  
    


module.exports={getAuthToken,saveXpressbees,isEnabeled,disable,enable,getToken};