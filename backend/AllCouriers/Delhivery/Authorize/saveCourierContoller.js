if (process.env.NODE_ENV != "production") {
    require('dotenv').config();
}
const axios = require('axios');

const AllCourier = require("../../../models/AllCourierSchema");
const { getUniqueId } = require("../../getUniqueId");

const BASE_URL = process.env.DELHIVERY_URL;

const getDelhiveryApiKey = async (courierName) => {
    try {
        let courier;
        if (courierName) {
            courier = await AllCourier.findOne({ courierName: courierName, courierProvider: 'Delhivery' });
        } else {
            // If no specific courierName is provided, get the first active Delhivery account
            courier = await AllCourier.findOne({ courierProvider: 'Delhivery', status: 'active' });
            
            // If no active one found, just get the first one
            if (!courier) {
                courier = await AllCourier.findOne({ courierProvider: 'Delhivery' });
            }
        }
        
        // console.log("courier found:", courier ? courier.courierName : "None, using fallback");
        return courier ? courier.apiKey : process.env.DEL_API_TOKEN;
    } catch (error) {
        console.error("Error fetching Delhivery API key:", error);
        return process.env.DEL_API_TOKEN;
    }
};

const getToken = async (req, res) => {
    const { apiKey } = req.body.credentials;  // Destructure apiKey from the request body
    const { courierName, courierProvider, CODDays, status } = req.body;  // Destructure courier data from the request body

    // Removed manual token validation to allow multiple accounts

    try {
        // Check if an account with the same courierName already exists
        const existingByName = await AllCourier.findOne({ courierName });
        if (existingByName) {
            return res.status(400).json({ message: `Courier account with name '${courierName}' already exists.` });
        }

        // Check if an account with the same apiKey already exists for Delhivery
        const existingByApiKey = await AllCourier.findOne({ apiKey, courierProvider: 'Delhivery' });
        if (existingByApiKey) {
            return res.status(400).json({ message: 'Delhivery account with this API key already exists.' });
        }

        const courierData = {
            courierName,
            courierProvider,
            CODDays,
            status,
            apiKey,
        };

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
        const { apiKey } = req.query;
        const response = await axios.get(`https://www.delhivery.com/api/v1/users/login`, {
            headers: {
                Authorization: `Token ${apiKey || process.env.DEL_API_TOKEN}`
            }
        });
        console.log("dfsdfdsf", response)
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
                courierName: req.body.name,
                createdName: req.body.name
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

const fetchBulkWaybills = async (count, apiKey) => {
    const url = `${BASE_URL}/waybill/api/bulk/json/?count=${count}`;

    try {
        const response = await axios.get(url, {
            headers: {
                "Content-Type": "application/json",
                Authorization: `Token ${apiKey || process.env.DEL_API_TOKEN}`,
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

module.exports = { saveDelhivery, isEnabeled, getCourierList, enable, disable, addService, fetchBulkWaybills, getToken, getDelhiveryApiKey };