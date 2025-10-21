if(process.env.NODE_ENV!="production"){
  require('dotenv').config();
  }
const axios = require("axios");

const AllCourier = require("../../../models/AllCourierSchema");
const BASE_URL=process.env.SHIPROCKET_URL;

const getToken = async (req,res) => {
    const email = req.body.credentials.username;
    const password = req.body.credentials.password;
    const courierData ={
          courierName : req.body.courierName,
          courierProvider : req.body.courierProvider,
          CODDays: req.body.CODDays,
          status:req.body.status

    }

    if (!email || !password) {
        return res.status(400).json({
            message: "Email and password are required.",
        });
    } 

    try {
        const options = {
            method: "POST",
            url: `${BASE_URL}/v1/external/auth/login`,
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
            },
            data: { email, password },
        };

        const response = await axios.request(options);

        if (response.status === 200 && response.data.token) {
          const newCourier = new AllCourier(courierData);
          await newCourier.save();
          return response.data.token;

        } else {
            throw new Error(`Login failed: Status ${response.status}`);
        }
    } catch (error) {
        if (error.response) {
            throw new Error(`Error in authentication: ${error.response.data.message || error.message}`);
        } else {
            throw new Error(`Error in authentication: ${error.message}`);
        }
    }
};



const saveShipRocket = async (req, res) => {
   
    console.log("I am in shiprocket");
    try {
        const existingCourier = await Courier.findOne({ provider: 'Shiprocket' });

        if (existingCourier) {
            return res.status(400).json({ message: 'Shiprocket service is already added' });
        }

        const newCourier = new Courier({
            provider: 'Shiprocket'
        });
        await newCourier.save();
        res.status(201).json({ message: 'Shiprocket Integrated Successfully' });
    } catch (error) {
        res.status(500).json({ message: 'An error has occurred', error: error.message });
    }
};

const isEnabeled = async (req, res) => {
    try {
        const existingCourier = await Courier.findOne({ provider:'Shiprocket' });
    
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
      const existingCourier = await Courier.findOne({ provider: 'Shiprocket' });
  
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
      const existingCourier = await Courier.findOne({ provider: 'Shiprocket'});
  
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

  const getAuthToken = async ()=>{
    
        
        const email= process.env.SHIPR_GMAIL
        const password=process.env.SHIPR_PASS
          

  
  
          
        
        if (!email || !password) {
          return res.status(400).json({
              message: "Email and password are required.",
          });
      } 
  
      try {
          const options = {
              method: "POST",
              url: `${BASE_URL}/v1/external/auth/login`,
              headers: {
                  Accept: "application/json",
                  "Content-Type": "application/json",
              },
              data: { email, password },
          };
  
          const response = await axios.request(options);
  
          if (response.status === 200 && response.data.token) {
            
            
            return response.data.token;
  
          } else {
              throw new Error(`Login failed: Status ${response.status}`);
          }
      } catch (error) {
            console.log(error)
        }
      }

module.exports = { saveShipRocket, getToken, isEnabeled, disable,enable, getAuthToken };
