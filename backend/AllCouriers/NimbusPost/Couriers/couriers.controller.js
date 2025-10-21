if (process.env.NODE_ENV != "production") {
    require('dotenv').config();
}

const axios = require('axios');
const mongoose = require("mongoose");

const { getToken } = require("../Authorize/nimbuspost.controller");
const { getUniqueId } = require("../../getUniqueId");
const crypto = require('crypto');
const url=process.env.NIMBUSPOST_URL;


const getCouriers = async (req, res) => {

// console.log('hiii')
    try {
        const token = await getToken();
        // console.log(token)
        const response = await axios.get(`${url}/v1/courier`, {
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`
            }
        });
        
    
        // console.log(response.data)  
        if (response.data.status) {
            const servicesData = response.data.data;
            // const currCourier = await Courier.findOne({ provider: 'NimbusPost' }).populate('services');
            // console.log(currCourier)

            // const prevServices = new Set(currCourier.services.map(service => service.courierProviderServiceName));
            // console.log(prevServices)

            const allServices = servicesData.map(element => ({
                service: element.name,
                provider_courier_id: element.id,
                // isAdded: prevServices.has(element.name)
            }));
            // console.log(allServices)
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


        const currCourier = await Courier.findOne({ provider: 'NimbusPost' });

        const prevServices = new Set();
        const services = await Services.find({ '_id': { $in: currCourier.services } });

        services.forEach(service => {
            prevServices.add(service.courierProviderServiceName);
        });

        const name = req.body.service;
        const provider_courier_id = req.body.provider_courier_id;

        if (!prevServices.has(name)) {
            const newService = new Services({
                courierProviderServiceId: getUniqueId(),
                courierProviderServiceName: name,
                courierProviderName: 'NimbusPost',
                provider_courier_id,
                createdName: req.body.name
            });

            const Nimb = await Courier.findOne({ provider: 'NimbusPost' });
            Nimb.services.push(newService._id);

            await newService.save();
            await Nimb.save();

            console.log(`New service saved: ${name}`);

            return res.status(201).json({ message: `${name} has been successfully added` });
        }

        return res.status(400).json({ message: `${name} already exists` });
    } catch (error) {
        console.error(`Error adding service: ${error.message}`);
        res.status(500).json({ message: 'Internal Server Error', error: error.message });
    }
};



const getServiceablePincodes = async (req, res) => {

    console.log("I am in serviceability pincode");

    const { pincode } = req.body;
    try {
        const token = await getToken();

        const response = await axios.get(`${url}/v1/courier/serviceability`, {
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
            },
        });

        if (response.data.status) {
            let fetchedData = response.data.data;
            let info = {};
            for (d of fetchedData) {
                if (d.pincode == pincode) {
                    info.cod = d.cod;
                    info.prepaid = d.prepaid;
                    break;
                }
            }
            return res.status(200).json(info);
        } else {
            return res.status(400).json({ error: 'Error in fetching serviceable pincodes', details: response.data });
        }
    } catch (error) {
        console.error('Error in fetching serviceable pincodes:', error.response?.data || error.message);
        return res.status(500).json({ error: 'Internal Server Error', message: error.message });
    }
};

const getServiceablePincodesData = async (service, payload) => {

    try {
        const token = await getToken();
        // console.log(token);
        // console.log(url);
        // console.log(service);
        // console.log(payload);
        
        

        const response = await axios.post(`${url}/v1/courier/serviceability`, payload, {
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`
            },
        });
        // console.log("sadkhsajkda");
        
// console.log("response",response.data.data);
// console.log(service);



        if (response.data.status) {
            const filteredData = response.data.data.filter((item) => item.name === service);
            return filteredData.length > 0;
        } else {
            throw new Error('Error in fetching serviceable pincodes');
        }
    } catch (error) {
        console.error('Error in fetching serviceable pincodes:', error.response?.data || error.message);
        throw new Error(error.response?.data || error.message);
    }
};



module.exports = {
    getServiceablePincodes, getCouriers, getServiceablePincodesData, addService
};







