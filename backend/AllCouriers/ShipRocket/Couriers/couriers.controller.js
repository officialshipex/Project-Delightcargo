if(process.env.NODE_ENV!="production"){
    require('dotenv').config();
} 

const axios = require('axios');
const mongoose = require("mongoose");

const {getAuthToken, getToken } = require("../Authorize/shiprocket.controller");
const { getUniqueId } = require("../../getUniqueId");
const BASE_URL=process.env.SHIPROCKET_URL;


const getAllActiveCourierServices = async (req, res) => {
    try {
        // Get the authentication token
        const token = await getAuthToken();

        // Define request options
        const options = {
            method: "GET",
            url: `${BASE_URL}/v1/external/courier/courierListWithCounts?type=active`,
            headers: {
                "content-type": "application/json",
                Authorization: `Bearer ${token}`,
            },
        };

        // Make the API request
        const response = await axios.request(options);

        // console.log(token);

        // console.log(response);

        if (response?.data?.courier_data) {
            const servicesData = response.data.courier_data;
            // const currCourier = await Courier.findOne({ provider: 'Shiprocket' }).populate('services');
            // const prevServices = new Set(currCourier.services.map(service => service.courierProviderServiceName));

            const allServices = servicesData.map(element => ({
                service: element.name,
                provider_courier_id:element.id,
                // isAdded: prevServices.has(element.name)
            }));

            return res.status(201).json(allServices);

        } else {
            res.status(400).json({ message: 'Failed to fetch services' });
        }
    } catch (error) {
        console.error('Error:', error.response ? error.response.data : error.message);
        res.status(500).json({ error: 'Failed to fetch couriers', details: error.message });
    }
};





const addService = async (req, res) => {
    try {
        

        const currCourier = await Courier.findOne({ provider: 'Shiprocket' });

        if (!currCourier) {
            return res.status(404).json({ message: 'Courier not found' });
        }

        const prevServices = new Set(currCourier.services.map(serviceId => serviceId.toString()));
        const name = req.body.service;
        const provider_courier_id=req.body.provider_courier_id;

        if (!prevServices.has(name)) {
            const newService = new Services({
                courierProviderServiceId: getUniqueId(),
                courierProviderServiceName: name,
                courierProviderName:'Shiprocket',
                provider_courier_id,
                createdName:req.body.name
            });

            currCourier.services.push(newService._id);

            await newService.save();
            await currCourier.save();

            console.log(`New service saved: ${name}`);

            return res.status(201).json({ message: `${name} has been successfully added` });
        }

        return res.status(400).json({ message: `${name} already exists` });
    } catch (error) {
        console.error(`Error adding service: ${error.message}`);
        res.status(500).json({ message: 'Internal Server Error', error: error.message });
    }
};






module.exports = {
    getAllActiveCourierServices,addService
};


