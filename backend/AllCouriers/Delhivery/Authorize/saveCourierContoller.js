if(process.env.NODE_ENV!="production"){
require('dotenv').config();
}
const axios = require('axios');

const AllCourier=require("../../../models/AllCourierSchema");
const { getUniqueId } = require("../../getUniqueId");

const API_TOKEN = process.env.DEL_API_TOKEN;
const BASE_URL=process.env.DELHIVERY_URL;

const getToken = async (req, res) => {
    const { apiKey } = req.body.credentials;  // Destructure apiKey from the request body
    const { courierName, courierProvider, CODDays, status } = req.body;  // Destructure courier data from the request body

    // Validate if the API token matches the provided apiKey
    if (API_TOKEN !== apiKey) {
        // If the token does not match, return an unauthorized response
        return res.status(401).json({ message: 'Unauthorized access. Invalid API key.' });
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

        // Return a success response with the newly created courier data
        return res.status(201).json({
            message: 'Courier successfully added.',
            courier: newCourier,
        });
    } catch (error) {
        // Handle errors gracefully and return a detailed error message
        return res.status(500).json({
            message: 'Failed to add courier.',
            error: error.message,
        });
    }
};


const saveDelhivery = async (req, res) => {
    try {
        const existingCourier = await Courier.findOne({ provider: 'Delhivery' });

        if (existingCourier) {
            return res.status(400).json({ message: 'Delhivery service is already added' });
        }

        const newCourier = new Courier({
            provider: 'Delhivery'
        });
        await newCourier.save();
        res.status(201).json({ message: 'Delhivery Integrated Successfully' });
    } catch (error) {
        res.status(500).json({ message: 'An error has occurred', error: error.message });
    }
};


const isEnabeled = async (req, res) => {
    try {
        const existingCourier = await Courier.findOne({ provider: 'Delhivery' });

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

const getCourierList = async (req, res) => {

    try {
       const response = await axios.get(`https://www.delhivery.com/api/v1/users/login`, {
                   headers: {
                       Authorization: `Token ${API_TOKEN}`
                   }
               });
               console.log("dfsdfdsf",response)
            const currCourier = await Courier.findOne({ provider: 'Delhivery' })
            const servicesData = currCourier.services;

            const allServices = servicesData.map(element => ({
                service: element.courierProviderServiceName,
                isAdded: true
            }));

            return res.status(201).json(allServices);
        

        res.status(400).json({ message: 'Failed to fetch services' });
    } catch (error) {
        res.status(500).json({
            error: "Failed to fetch courier list",
            details: error.response?.data || error.message,
        });
    }
};


const enable = async (req, res) => {

    try {
        const existingCourier = await Courier.findOne({ provider: 'Delhivery' });

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
        const existingCourier = await Courier.findOne({ provider: 'Delhivery' });

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


const addService = async (req, res) => {
    try {
        console.log("I am in addService of Delhivery");

        const currCourier = await Courier.findOne({ provider: 'Delhivery' });

        const prevServices = new Set();
        const services = await Services.find({ '_id': { $in: currCourier.services } });

        services.forEach(service => {
            prevServices.add(service.courierProviderServiceName);
        });

        const name = req.body.service;


        if (!prevServices.has(name)) {
            const newService = new Services({
                courierProviderServiceId: getUniqueId(),
                courierProviderServiceName: name,
                courierProviderName: 'Delhivery',
                createdName:req.body.name
            });

            const S2 = await Courier.findOne({ provider: 'Delhivery' });
            S2.services.push(newService._id);

            await newService.save();
            await S2.save();

            // console.log(`New service saved: ${name}`);

            return res.status(201).json({ message: `${name} has been successfully added` });
        }

        return res.status(400).json({ message: `${name} already exists` });
    } catch (error) {
        console.error(`Error adding service: ${error.message}`);
        res.status(500).json({ message: 'Internal Server Error', error: error.message });
    }
};

const fetchBulkWaybills = async (count) => {
    const url = `${BASE_URL}/waybill/api/bulk/json/?count=${count}`;

    try {
        const response = await axios.get(url, {
            headers: {
                "Content-Type": "application/json",
                Authorization: `Token ${API_TOKEN}`,
            }
        });


        const result = response.data.split(',')

        if (response.data) {
            return result
        } else {
            return null;
        }
    } catch (error) {
        console.log(error);
        return null

    }
};

module.exports = { saveDelhivery, isEnabeled, getCourierList, enable, disable, addService, fetchBulkWaybills, getToken };