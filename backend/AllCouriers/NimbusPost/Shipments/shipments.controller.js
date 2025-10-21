if (process.env.NODE_ENV != "production") {
    require('dotenv').config();
}

const axios = require('axios');
const { getAuthToken } = require("../Authorize/nimbuspost.controller");
// const Order = require("../../../models/orderSchema.model");
const Wallet = require("../../../models/wallet");
const url = process.env.NIMBUSPOST_URL;


const createShipment = async (req, res) => {
    const { selectedServiceDetails, id, wh } = req.body.payload;
    const currentOrder = await Order.findById(id);
    const currentWallet = await Wallet.findById(req.body.walletId);
    const order_items = new Array(currentOrder.Product_details.length);

    currentOrder.Product_details.map((item, index) => {
        order_items[index] = {
            name: item.product,
            qty: item.quantity,
            price: item.amount,
            sku: item.sku
        };
    });


    let payment_type = currentOrder.order_type === "Cash on Delivery" ? "cod" : "prepaid";
    const shipmentData = {
        order_number: `${currentOrder.order_id}`,
        payment_type,
        order_amount: currentOrder.sub_total,
        consignee: {
            name: `${currentOrder.shipping_details.firstName} ${currentOrder.shipping_details.lastName}`,
            address: `${currentOrder.shipping_details.address} ${currentOrder.shipping_details.address2}`,
            city: currentOrder.shipping_details.city,
            state: currentOrder.shipping_details.state,
            pincode: `${currentOrder.shipping_details.pinCode}`,
            phone: currentOrder.shipping_details.phone
        },
        pickup: {
            warehouse_name: wh.warehouseName,
            name: wh.contactName,
            address: `${wh.addressLine1} ${wh.addressLine2}`,
            city: wh.city,
            state: wh.state,
            pincode: wh.pinCode,
            phone: parseInt(wh.contactNo)
        },
        order_items,
        courier_id: selectedServiceDetails.provider_courier_id
    };



    try {
        const token = await getAuthToken();
        const response = await axios.post(`${url}/v1/shipments`, shipmentData, {
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`
            }
        });

        if (response.data.status) {
            const result = response.data.data;
            currentOrder.status = 'Booked';
            currentOrder.cancelledAtStage = null;
            currentOrder.awb_number = result.awb_number;
            currentOrder.shipment_id = `${result.awb_number}`;
            currentOrder.service_details = selectedServiceDetails._id;
            currentOrder.freightCharges = req.body.finalCharges === "N/A" ? 0 : parseInt(req.body.finalCharges);
            currentOrder.tracking = [];
            currentOrder.tracking.push({
                stage: 'Order Booked'
            });
            let savedOrder = await currentOrder.save();
            let balanceToBeDeducted = req.body.finalCharges === "N/A" ? 0 : parseInt(req.body.finalCharges);
            let currentBalance = currentWallet.balance - balanceToBeDeducted;
            await currentWallet.updateOne({
                $inc: { balance: -balanceToBeDeducted },
                $push: {
                    transactions: {
                        txnType: "Shipping",
                        action: "debit",
                        amount: currentBalance,
                        balanceAfterTransaction: currentWallet.balance - balanceToBeDeducted,
                        awb_number: `${result.awb_number}`,
                    },
                },
            });


            return res.status(201).json({ message: "Shipment Created Succesfully" });
        } else {
            return res.status(400).json({ error: 'Error creating shipment', details: response.data });
        }
    } catch (error) {
        console.log(error);
        console.error('Error in creating shipment:', error.message);
        return res.status(500).json({ error: 'Internal Server Error', message: error.message });
    }
};



const trackShipmentNimbuspost = async (trackingNumber) => {

    if (!trackingNumber) {
        return res.status(400).json({ error: 'Tracking number is required' });
    }


    try {
        const token = await getAuthToken();
        const response = await axios.get(`${url}/v1/shipments/track/${trackingNumber}`, {
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`
            }
        });
        if (response.data.status) {
            const result = response.data.data;
            return ({
                success: true,
                data: result.status
            });
        }
        else {
            return ({
                success: false,
                data: "Error in tracking"
            });
        }

    } catch (error) {
        console.log(error);
        return ({
            success: false,
            data: "Error in tracking"
        });
    }
};



const trackShipmentsInBulk = async (req, res) => {
    const { awbNumbers } = req.body;

    if (!awbNumbers || !Array.isArray(awbNumbers) || awbNumbers.length === 0) {
        return res.status(400).json({ error: 'AWB numbers must be a non-empty array' });
    }

    try {
        const token = await getAuthToken();
        const payload = { awb: awbNumbers };

        const response = await axios.post(`${url}/v1/shipments/track/bulk`, payload, {
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`
            }
        });

        if (response.data.status) {
            return res.status(200).json(response.data.data);
        } else {
            return res.status(400).json({ error: 'Error tracking shipments in bulk', details: response.data });
        }
    } catch (error) {
        // console.error('Error in tracking shipments in bulk:', error.response?.data || error.message);
        return res.status(500).json({ error: 'Internal Server Error', message: error.message });
    }
};



const manifest = async (req, res) => {
    const { awbNumbers } = req.body;

    if (!awbNumbers || !Array.isArray(awbNumbers) || awbNumbers.length === 0) {
        return res.status(400).json({ error: 'AWB numbers must be a non-empty array' });
    }

    try {
        const token = await getAuthToken();
        const payload = { awbs: awbNumbers };

        const response = await axios.post(`${url}/v1/shipments/manifest`, payload, {
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`
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
        const token = await getAuthToken();
        const payload = { awb };
        const headers = {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        };

        const response = await axios.post(`${url}/v1/shipments/cancel`, payload, { headers });

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
        console.error(
            'Error in cancelling shipment:',
            error.response?.data || error.message
        );
        return {
            error: 'Internal Server Error',
            message: error.message,
            code: 500,
        };
    }
};



const createHyperlocalShipment = async (req, res) => {

    const { shipmentData } = req.body;
    const {
        order_number,
        payment_type,
        order_amount,
        package_weight,
        consignee,
        pickup,
        order_items,
    } = shipmentData;

    if (
        !order_number ||
        !payment_type ||
        !order_amount ||
        !package_weight ||
        !consignee ||
        !pickup ||
        !order_items ||
        order_items.length === 0
    ) {
        return res.status(400).json({ error: 'Missing required fields or invalid data' });
    }


    try {
        const token = await getAuthToken();
        const payload = shipmentData;

        const response = await axios.post(`${url}/v1/shipments/hyperlocal`, payload, {
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
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
    createShipment,
    trackShipmentNimbuspost,
    trackShipmentsInBulk,
    manifest,
    cancelShipment,
    createHyperlocalShipment
};





