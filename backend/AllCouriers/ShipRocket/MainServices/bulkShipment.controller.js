if (process.env.NODE_ENV != "production") {
    require('dotenv').config();
}
const axios = require("axios");
const Order = require("../../../models/newOrder.model");
const { getToken } = require("../Authorize/shiprocket.controller");
const Wallet = require("../../../models/wallet");
const { assignPickupManifest } = require("../../../Orders/scheduledPickup.controller");

const BASE_URL = process.env.SHIPROCKET_URL;

const getCurrentDateTime = () => {
    const now = new Date();
    const date = now.toISOString().split('T')[0];
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    return `${date} ${hours}:${minutes}`;
};

function generateSKU(productName) {
    const timestamp = Date.now();
    const randomPart = Math.floor(1000 + Math.random() * 9000);
    const sanitizedProductName = productName.replace(/[^a-zA-Z0-9]/g, '').substring(0, 5).toUpperCase();

    return `${sanitizedProductName}-${timestamp}-${randomPart}`;
}
// 1. Create Custom Order

const assignAWB = async (shipment_id, courier_id) => {
    try {
        const token = await getToken();
        const response = await axios.post(
            `${BASE_URL}/v1/external/courier/assign/awb`,
            {
                shipment_id,
                courier_id,
            },
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
            }
        );

        return response.data.response.data;

    } catch (error) {
        return null;

    }
};


const createShipmentFunctionShipRocket = async (
    selectedServiceDetails, id, wh,
    walletId,
    finalCharges,
) => {
    try {
        console.log("I am in createShipment BulkShiprocket");
        const currentOrder = await Order.findById(id);
        const currentWallet = await Wallet.findById(walletId);

        const order_items = currentOrder.Product_details.map((item) => ({
            name: item.product,
            units: item.quantity,
            selling_price: item.amount,
            sku: item.sku || generateSKU(item.product),
        }));

        const payment_type =
            currentOrder.order_type === "Cash on Delivery" ? "COD" : "Prepaid";
        const currentDateTime = getCurrentDateTime();
        const shipmentData = {
            order_id: `${currentOrder.order_id}`,
            order_date: currentDateTime,
            pickup_location: wh.warehouseName,
            billing_customer_name: `${currentOrder.Biling_details.firstName}`,
            billing_last_name: `${currentOrder.Biling_details.lastName}`,
            billing_address: currentOrder.Biling_details.address,
            billing_address_2: currentOrder.Biling_details.address2,
            billing_city: currentOrder.Biling_details.city,
            billing_pincode: `${currentOrder.shipping_details.pinCode}`,
            billing_state: currentOrder.shipping_details.state,
            billing_country: "India",
            billing_email: currentOrder.shipping_details.email,
            billing_phone: currentOrder.Biling_details.phone,
            shipping_is_billing: currentOrder.shipping_is_billing,
            order_items,
            payment_method: payment_type,
            sub_total: currentOrder.sub_total,
            length: currentOrder.shipping_cost.dimensions.length,
            breadth: currentOrder.shipping_cost.dimensions.width,
            height: currentOrder.shipping_cost.dimensions.height,
            weight:
                Math.max(
                    parseInt(currentOrder.shipping_cost.weight),
                    currentOrder.shipping_cost.volumetricWeight
                ) / 1000,
        };

        if (!currentOrder.shipping_is_billing) {
            Object.assign(shipmentData, {
                shipping_customer_name: currentOrder.shipping_details.firstName,
                shipping_last_name: currentOrder.shipping_details.lastName,
                shipping_address: currentOrder.shipping_details.address,
                shipping_address_2: currentOrder.shipping_details.address2,
                shipping_city: currentOrder.shipping_details.city,
                shipping_pincode: `${currentOrder.shipping_details.pinCode}`,
                shipping_state: currentOrder.shipping_details.state,
                shipping_email: currentOrder.shipping_details.email,
                shipping_country: "India",
                shipping_phone: currentOrder.shipping_details.phone,
            });
        }

        const token = await getToken();
        const response = await axios.post(
            `${BASE_URL}/v1/external/orders/create/adhoc`,
            shipmentData,
            { headers: { Authorization: `Bearer ${token}` } }
        );

        console.log("Response from ShipRocket:", response);

        if (response.status != 200) {
            return { status: 400, error: 'Error creating shipment', details: response.data };
        }

        const { shipment_id } = response.data;
        const courier_id = selectedServiceDetails.provider_courier_id;
        const result = await assignAWB(shipment_id, courier_id);
        console.log(result);

        if (!result || !result.awb_code) {
            throw new Error("Failed to assign AWB");
        }

        currentOrder.status = "Booked";
        currentOrder.cancelledAtStage = null;
        currentOrder.awb_number = result.awb_code;
        currentOrder.shipment_id = shipment_id;
        currentOrder.service_details = selectedServiceDetails._id;
        currentOrder.freightCharges =
            finalCharges === "N/A" ? 0 : parseInt(finalCharges);
        currentOrder.tracking = [{ stage: "Order Booked" }];

        const savedOrder = await currentOrder.save();

        // ── Auto-assign pickup manifest ──
        try {
            await assignPickupManifest(currentOrder);
        } catch (pErr) {
            console.error("[Pickup] assignPickupManifest failed:", pErr.message);
        }
        const balanceToBeDeducted =
            finalCharges === "N/A" ? 0 : parseInt(finalCharges);

        const saveWallet = await currentWallet.updateOne({
            $inc: { balance: -balanceToBeDeducted },
            $push: {
                transactions: {
                    txnType: "Shipping",
                    action: "debit",
                    amount: balanceToBeDeducted,
                    balanceAfterTransaction: currentWallet.balance - balanceToBeDeducted,
                    awb_number: `${result.awb_code}`,
                },
            },
        });

        console.log("Saved Wallet", saveWallet);

        return { status: 201, message: "Shipment Created Successfully" };
    } catch (error) {
        console.error('Error in creating shipment:', error.message);
        console.log(error);
        return { status: 500, error: 'Internal Server Error', message: error.message };
    }
};


module.exports = { createShipmentFunctionShipRocket };