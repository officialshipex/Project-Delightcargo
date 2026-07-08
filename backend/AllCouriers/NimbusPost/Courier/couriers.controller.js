if (process.env.NODE_ENV != "production") {
    require('dotenv').config();
}

const axios = require('axios');
const mongoose = require("mongoose");
const getUniqueId = require("../../getUniqueId");
const createNimbuspostShipment = require("../../../API/Courier/nimbuspostShipmentCreation.controller");

const Order = require("../../../models/newOrder.model");
const User = require("../../../models/User.model");
const Wallet = require("../../../models/wallet");
const WalletTransaction = require("../../../models/WalletTransaction.model");

// Schema models for courier setup
const Courier = require("../../../models/courierSecond");
const Services = require("../../../models/courierServiceSecond.model");
const AllCourier = require("../../../models/AllCourierSchema");
const CourierService = require("../../../models/CourierService.Schema");

const url = process.env.NIMBUSPOST_URL || "https://ship.nimbuspost.com/api";
const API_KEY = process.env.NIMBUS_API_KEY;

// ─── Courier Setup (Admin) ────────────────────────────────────────────────────
const getCouriers = async (req, res) => {
    try {
        const response = await axios.get(`${url}/couriers`, {
            headers: {
                'Content-Type': 'application/json',
                'NP-API-KEY': API_KEY
            }
        });
        
        if (response.data.status) {
            // console.log("courier",response.data)
            const servicesData = response.data.data;
            const allServices = servicesData.map(element => ({
                service: element.name,
                provider_courier_id: String(element.id),
            }));
            return res.status(201).json(allServices);
        }

        res.status(400).json({ message: 'Failed to fetch services' });

    } catch (error) {
        console.error('Error in getCouriers:', error.response ? error.response.data : error.message);
        res.status(500).json({ error: 'Failed to fetch couriers', details: error.message });
    }
};

const addService = async (req, res) => {
    try {
        const currCourier = await Courier.findOne({ provider: 'NimbusPost' });
        if (!currCourier) {
            return res.status(404).json({ message: 'NimbusPost courier provider not found in DB' });
        }

        const prevServices = new Set();
        const services = await Services.find({ '_id': { $in: currCourier.services } });

        services.forEach(service => {
            prevServices.add(service.courierProviderServiceName);
        });

        const name = req.body.service;                       // NimbusPost courier name (e.g. "Delhivery Surface")
        const provider_courier_id = req.body.provider_courier_id; // NimbusPost courier ID (e.g. "5")
        const serviceName = req.body.name || name;           // Our internal rate card service name (e.g. "Delhivery Surface 500GM")

        if (!prevServices.has(name)) {
            const newService = new Services({
                courierProviderServiceId: getUniqueId(),
                courierProviderServiceName: name,
                courierProviderName: 'NimbusPost',
                provider_courier_id,
                createdName: serviceName
            });

            currCourier.services.push(newService._id);
            await newService.save();
            await currCourier.save();

            // ✅ Also persist courier_id to CourierService.Schema
            // This is the model used by bookOrder & shipment creation to find the NimbusPost courier ID
            if (provider_courier_id) {
                const updateResult = await CourierService.updateMany(
                    { provider: 'NimbusPost', courier: name },
                    { $set: { courier_id: String(provider_courier_id) } }
                );
                console.log(`Updated courier_id=${provider_courier_id} for CourierService records matching courier='${name}':`, updateResult.modifiedCount, 'updated');
            }

            console.log(`New service saved: ${name}`);
            return res.status(201).json({ message: `${name} has been successfully added` });
        }

        return res.status(400).json({ message: `${name} already exists` });
    } catch (error) {
        console.error(`Error adding service: ${error.message}`);
        res.status(500).json({ message: 'Internal Server Error', error: error.message });
    }
};

// ─── Serviceability Check ─────────────────────────────────────────────────────
// NimbusPost is a courier aggregator/partner — serviceability is always true by default
const getServiceablePincodes = async (req, res) => {
    const { pincode } = req.body;
    if (!pincode) {
        return res.status(400).json({ error: 'Pincode is required' });
    }
    return res.status(200).json({
        cod: true,
        prepaid: true
    });
};

// NimbusPost is a courier aggregator/partner — always serviceable
const getServiceablePincodesData = async (service, payload) => {
    return { success: true, cod: true, prepaid: true };
};

// ─── Shipment Operations ──────────────────────────────────────────────────────
const createShipment = async (req, res) => {
    try {
        // Support both req.body.payload (old format) and direct req.body (new format)
        const body = req.body.payload || req.body;
        const { selectedServiceDetails, id, wh } = body;

        if (!id) {
            return res.status(400).json({ error: "Order ID (id) is required in request body" });
        }

        const currentOrder = await Order.findById(id);
        if (!currentOrder) {
            return res.status(404).json({ error: "Order not found" });
        }

        const user = await User.findById(currentOrder.userId);
        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        const wallet = await Wallet.findById(user.Wallet).select("balance holdAmount creditLimit");
        if (!wallet) {
            return res.status(404).json({ error: "Wallet not found" });
        }

        const finalCharges = req.body.finalCharges === "N/A" ? 0 : parseFloat(req.body.finalCharges || body.finalCharges || 0);
        const courierServiceName = selectedServiceDetails?.courierProviderServiceName
            || selectedServiceDetails?.name
            || req.body.courierServiceName
            || body.courierServiceName;

        const result = await createNimbuspostShipment({
            id,
            provider: "NimbusPost",
            finalCharges,
            courierServiceName,
            priceBreakup: req.body.priceBreakup || body.priceBreakup || {
                freight: finalCharges,
                cod: currentOrder.paymentDetails?.method === "COD" ? 30 : 0,
                gst: 0,
                total: finalCharges
            },
            userId: user._id,
            walletId: wallet._id,
            walletBalance: wallet.balance,
            walletHoldAmount: wallet.holdAmount,
            walletCreditLimit: wallet.creditLimit
        });

        if (result.success) {
            return res.status(201).json({ message: "Shipment Created Successfully", data: result });
        } else {
            return res.status(400).json({ error: result.message || "Error creating shipment", details: result });
        }
    } catch (error) {
        console.error("Error in createShipment handler:", error);
        return res.status(500).json({ error: "Internal Server Error", message: error.message });
    }
};

const createCustomOrder = async (req, res) => {
  try {
    const { id, finalCharges, courierServiceName, provider, priceBreakup } = req.body;

    const result = await createNimbuspostShipment({
      id,
      provider: provider || "NimbusPost",
      finalCharges,
      courierServiceName,
      priceBreakup
    });

    if (result.success) {
      return res.status(200).json(result);
    } else {
      return res.status(400).json(result);
    }
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

const trackShipmentNimbuspost = async (trackingNumber) => {
    if (!trackingNumber) {
        return { success: false, data: "Tracking number is required" };
    }

    try {
        const response = await axios.get(`${url}/shipments/track_awb/${trackingNumber}`, {
            headers: {
                'Content-Type': 'application/json',
                'NP-API-KEY': API_KEY
            }
        });

        if (response.data.status) {
            const result = response.data.data;
            const statusMap = {
                'PP': 'pending pickup',
                'IT': 'in transit',
                'EX': 'exception',
                'OFD': 'out for delivery',
                'DL': 'delivered',
                'RT': 'rto',
                'RT-IT': 'rto in transit',
                'RT-DL': 'rto delivered'
            };

            const parseDate = (timeVal) => {
                if (!timeVal) return null;
                if (!isNaN(timeVal)) {
                    return new Date(Number(timeVal) * 1000 + 5.5 * 60 * 60 * 1000);
                }
                const parts = String(timeVal).trim().split(/[T\-:\s]/);
                if (parts.length >= 6) {
                    const year = parseInt(parts[0], 10);
                    const month = parseInt(parts[1], 10) - 1;
                    const day = parseInt(parts[2], 10);
                    const hour = parseInt(parts[3], 10);
                    const minute = parseInt(parts[4], 10);
                    const second = parseInt(parts[5], 10);
                    return new Date(Date.UTC(year, month, day, hour, minute, second));
                }
                return new Date(timeVal);
            };

            let trackingHistory = [];
            if (result.history && Array.isArray(result.history) && result.history.length > 0) {
                trackingHistory = result.history.map(h => {
                    const rawCode = h.status_code || "";
                    const mappedDesc = statusMap[rawCode] || rawCode;
                    return {
                        status: mappedDesc,
                        status_code: rawCode,
                        city: h.location || "Unknown",
                        updated_on: parseDate(h.event_time),
                        remarks: h.message || h.remarks || ""
                    };
                });
                trackingHistory.reverse();
            } else {
                const rawStatus = result.status || "";
                const mappedDesc = statusMap[rawStatus] || rawStatus;
                trackingHistory = [{
                    status: mappedDesc,
                    status_code: rawStatus,
                    city: "Unknown",
                    updated_on: parseDate(result.event_time),
                    remarks: result.shipment_info || ""
                }];
            }

            return {
                success: true,
                data: trackingHistory
            };
        } else {
            return {
                success: false,
                data: "Error in tracking"
            };
        }
    } catch (error) {
        console.error("NimbusPost trackShipment Error:", error.response?.data || error.message);
        return {
            success: false,
            data: "Error in tracking"
        };
    }
};

const trackShipmentsInBulk = async (req, res) => {
    const { awbNumbers } = req.body;

    if (!awbNumbers || !Array.isArray(awbNumbers) || awbNumbers.length === 0) {
        return res.status(400).json({ error: 'AWB numbers must be a non-empty array' });
    }

    try {
        const results = await Promise.all(awbNumbers.map(async (awb) => {
            const r = await trackShipmentNimbuspost(awb);
            return { awb, status: r.success ? r.data : "unknown" };
        }));
        return res.status(200).json(results);
    } catch (error) {
        return res.status(500).json({ error: 'Internal Server Error', message: error.message });
    }
};

const manifest = async (req, res) => {
    const { awbNumbers } = req.body;

    if (!awbNumbers || !Array.isArray(awbNumbers) || awbNumbers.length === 0) {
        return res.status(400).json({ error: 'AWB numbers must be a non-empty array' });
    }

    try {
        const payload = { awbs: awbNumbers };
        const response = await axios.post(`${url}/shipments/manifest`, payload, {
            headers: {
                'Content-Type': 'application/json',
                'NP-API-KEY': API_KEY
            }
        });

        if (response.data.status) {
            return res.status(200).json(response.data.data);
        } else {
            return res.status(400).json({ error: 'Error in manifest creation', details: response.data });
        }
    } catch (error) {
        console.error('Error in creating manifest:', error.response?.data || error.message);
        return res.status(500).json({ error: 'Internal Server Error', message: error.message });
    }
};

const cancelShipment = async (awb) => {
    if (!awb) {
        return { error: 'AWB number is required', code: 400 };
    }

    try {
        let shipmentId = awb;
        const order = await Order.findOne({ $or: [{ awb_number: awb }, { shipment_id: awb }] });
        if (order && order.shipment_id) {
            shipmentId = order.shipment_id;
        }

        const response = await axios.post(`${url}/shipments/cancel`, {
            id: shipmentId
        }, {
                headers: {
                    'Content-Type': 'application/json',
                'NP-API-KEY': API_KEY
                }
        });

        const { status, data } = response.data;
        if (status) {
            return { data, code: 201 };
        } else {
            return {
                error: 'Error in shipment cancellation',
                details: response.data,
                code: 400,
            };
        }
    } catch (error) {
        console.error('Error in cancelling shipment:', error.response?.data || error.message);
        return {
            error: 'Internal Server Error',
            message: error.message,
            code: 500,
        };
    }
};

const createHyperlocalShipment = async (req, res) => {
    const { shipmentData } = req.body;
    if (!shipmentData) {
        return res.status(400).json({ error: 'Missing required fields or invalid data' });
    }

    try {
        const response = await axios.post(`${url}/shipments/hyperlocal`, shipmentData, {
            headers: {
                'Content-Type': 'application/json',
                'NP-API-KEY': API_KEY,
            },
        });

        if (response.data.status) {
            return res.status(200).json(response.data.data);
        } else {
            return res.status(400).json({ error: 'Error in creating hyperlocal shipment', details: response.data });
        }
    } catch (error) {
        console.error('Error in creating hyperlocal shipment:', error.response?.data || error.message);
        return res.status(500).json({ error: 'Internal Server Error', message: error.message });
    }
};

module.exports = {
    getCouriers,
    addService,
    getServiceablePincodes,
    getServiceablePincodesData,
    createShipment,
    createCustomOrder,
    trackShipmentNimbuspost,
    trackShipmentsInBulk,
    manifest,
    cancelShipment,
    createHyperlocalShipment
};
