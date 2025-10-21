if(process.env.NODE_ENV!="production"){
    require('dotenv').config();
  }
const axios = require('axios');
const mongoose = require("mongoose");

const { getAuthToken, getToken } = require("../Authorize/XpressbeesAuthorize.controller");
const { getUniqueId } = require("../../getUniqueId");

  
const BASE_URL=process.env.XpreesbeesUrl;


const getCourierList = async (req, res) => {
    try {
        const token = await getToken();
   console.log("dashsjdas",token)
        const response = await axios.get(`${BASE_URL}/api/courier`, {
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`
            }
        });
  console.log("adsdasd",response)
        if (response.data.status) {
            const servicesData = response.data.data;
            const allServices = servicesData.map(element => ({
                service: element.name,
                provider_courier_id:element.id,
            }));

            return res.status(201).json(allServices);
        }

        res.status(400).json({ message: 'Failed to fetch services' });

    } catch (error) {
        console.error('Error:', error.response ? error.response.data : error.message);
        res.status(500).json({ error: 'Failed to fetch couriers', details: error.message });
    }
};




const addService = async (req, res) => {
    try {
        
        const currCourier = await Courier.findOne({ provider: 'Xpressbees' });

        const prevServices = new Set();
        const services = await Services.find({ '_id': { $in: currCourier.services } });

        services.forEach(service => {
            prevServices.add(service.courierProviderServiceName);
        });

        const name = req.body.service;
        const provider_courier_id=req.body.provider_courier_id;

        if (!prevServices.has(name)) {
            const newService = new Services({
                courierProviderServiceId: getUniqueId(),
                courierProviderServiceName: name,
                courierProviderName:'Xpressbees',
                provider_courier_id,
                createdName:req.body.name
            });

            const Xpress = await Courier.findOne({ provider:'Xpressbees' });
            Xpress.services.push(newService._id);

            await newService.save();
            await Xpress.save();

            console.log(`New service saved: ${name}`);

            return res.status(201).json({ message: `${name} has been successfully added` });
        }

        return res.status(400).json({ message: `${name} already exists` });
    } catch (error) {
        console.error(`Error adding service: ${error.message}`);
        res.status(500).json({ message: 'Internal Server Error', error: error.message });
    }
};



    module.exports={
        getCourierList,addService
    }

