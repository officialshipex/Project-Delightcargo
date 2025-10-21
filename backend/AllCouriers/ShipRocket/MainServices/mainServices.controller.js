if (process.env.NODE_ENV != "production") {
  require('dotenv').config();
}
const axios = require("axios");
// const Order = require("../../../models/orderSchema.model");
const { getToken } = require("../Authorize/shiprocket.controller");
const Wallet = require("../../../models/wallet");

const BASE_URL = process.env.BASE_URL;

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
      `${BASE_URL}/courier/assign/awb`,
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



const createCustomOrder = async (req, res) => {

  console.log("I am in customCreate");
  const { selectedServiceDetails, id, wh } = req.body.payload;
  const currentOrder = await Order.findById(id);
  const currentWallet = await Wallet.findById(req.body.walletId);
  const order_items = new Array(currentOrder.Product_details.length);

  currentOrder.Product_details.map((item, index) => {
    order_items[index] = {
      name: item.product,
      units: item.quantity,
      selling_price: item.amount,
      sku: item.sku || generateSKU(item.product)
    };
  });


  let payment_type = currentOrder.order_type === "Cash on Delivery" ? "COD" : "Prepaid";
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
    weight: Math.max(parseInt(currentOrder.shipping_cost.weight), currentOrder.shipping_cost.volumetricWeight) / 1000
  };

  if (!currentOrder.shipping_is_billing) {
    shipmentData.shipping_customer_name = currentOrder.shipping_details.firstName;
    shipmentData.shipping_last_name = currentOrder.shipping_details.lastName;
    shipmentData.shipping_address = currentOrder.shipping_details.address;
    shipmentData.shipping_address_2 = currentOrder.shipping_details.address2;
    shipmentData.shipping_city = currentOrder.shipping_details.city;
    shipmentData.shipping_pincode = `${currentOrder.shipping_details.pinCode}`;
    shipmentData.shipping_state = currentOrder.shipping_details.state;
    shipmentData.shipping_email = currentOrder.shipping_details.email;
    shipmentData.shipping_country = "India";
    shipmentData.shipping_phone = currentOrder.shipping_details.phone;
  }

  try {
    const token = await getToken();
    const response = await axios.post(
      `${BASE_URL}/orders/create/adhoc`,
      shipmentData,
      { headers: { Authorization: `Bearer ${token}` } }
    );


    if (response.data.status) {
      const { shipment_id } = response.data;
      const courier_id = selectedServiceDetails.provider_courier_id;

      const result = await assignAWB(shipment_id, courier_id);
      console.log("Shiprocket result is", result);

      if (!result || !result.awb_code) {
        console.error("Invalid response from assignAWB:", result);
        return res.status(400).json({
          error: "Failed to assign AWB",
          details: result,
        });
      }

      currentOrder.status = 'Booked';
      currentOrder.cancelledAtStage = null;
      currentOrder.awb_number = result.awb_code;
      currentOrder.shipment_id = shipment_id;
      currentOrder.service_details = selectedServiceDetails._id;
      currentOrder.freightCharges = req.body.finalCharges === "N/A" ? 0 : parseInt(req.body.finalCharges);
      currentOrder.tracking = [];
      currentOrder.tracking.push({
        stage: 'Order Booked'
      });

      const savedOrder = await currentOrder.save();
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
            awb_number: `${result.awb_code}`,
          },
        },
      });
      return res.status(201).json({ message: "Shipment Created Successfully" });
    } else {
      return res.status(400).json({
        error: 'Error creating shipment',
        details: response.data,
      });
    }
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: error.response?.data || error.message });
  }
};





// 2. Update Order
const updateOrder = async (req, res) => {
  const { order_id } = req.params;
  const orderData = req.body;

  try {
    const token = await getToken();
    const response = await axios.put(
      `${BASE_URL}/orders/update/${order_id}`,
      orderData,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: error.response?.data || error.message });
  }
};

const cancelOrder = async (awb_number) => {
  try {
    console.log("AWB Number:", awb_number);
    console.log("I am being called");

    const token = await getToken();
    console.log("Token:", token);

    const response = await axios.post(
      `${BASE_URL}/orders/cancel/shipment/awbs`,
      { awbs: [`${awb_number}`] }, 
      {
        headers: {
          Authorization: `Bearer ${token}`, 
          'Content-Type': 'application/json', 
        },
      }
    );

    return { success: true, data: response.data };
  } catch (error) {
    console.error("Error:", error.response?.data || error.message);
    return { success: false, error: error.response?.data || error.message };
  }
};



// 4. List of Couriers
const listCouriers = async (req, res) => {
  try {
    const token = await getToken();
    const response = await axios.get(`${BASE_URL}/courier/all`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: error.response?.data || error.message });
  }
};

// 5. Check Courier Serviceability
async function checkServiceability(service, payload) {
  const pickup_postcode = payload.origin;
  const delivery_postcode = payload.destination;
  const cod = payload.payment_type === true ? 1 : 0;
  const weight = payload.weight || '1';

  try {
    const token = await getToken();
    const response = await axios.get(`${BASE_URL}/courier/serviceability/`, {
      headers: { Authorization: `Bearer ${token}` },
      params: { pickup_postcode, delivery_postcode, cod, weight },
    });

    const result = response.data?.data?.available_courier_companies || [];
    const filteredData = result.filter((item) => item.courier_name === service && item.blocked == 0);


    if (filteredData.length > 0) {
      return true;
    } else {
      console.log(`No courier service found matching: ${service}`);
      return false;
    }

  } catch (error) {
    console.error('Error Response:', error.response?.data || error.message);
    return false;
  }
}




// 6. Request for Shipment Pickup
const requestShipmentPickup = async (shipment_id) => {
  try {
    const token = await getToken();
    const response = await axios.post(
      `${BASE_URL}/courier/generate/pickup`,
      { shipment_id: [shipment_id] },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        }
      }
    );


    if (response.data.pickup_status == 1) {
      return {
        success: true,
        data: response.data,
        message: "Pickup request generated successfully",
      };
    } else {
      return {
        success: false,
        message: "Failed to generate pickup request. Please check the shipment details.",
      };
    }
  } catch (error) {
    console.error("Error generating shipment pickup:", error);
    return {
      success: false,
      message: error.response?.data?.message || "An unexpected error occurred.",
      error: error.response?.data || error.message,
    };
  }
};


// 7. Create a Return Order
const createReturnOrder = async (req, res) => {
  const { order_id, reason, items, pickup_location, pickup_address } = req.body;

  try {
    const token = await getToken();
    const response = await axios.post(
      `${BASE_URL}/orders/create/return`,
      { order_id, reason, items, pickup_location, pickup_address },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: error.response?.data || error.message });
  }
};

// 8. Generate Manifest
const generateManifest = async (req, res) => {
  const { shipment_id } = req.body;

  try {
    const token = await getToken();
    const response = await axios.post(
      `${BASE_URL}/manifests/generate`,
      { shipment_id },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: error.response?.data || error.message });
  }
};

// 9. Generate Label
const generateLabel = async (req, res) => {
  const { shipment_id } = req.body;

  try {
    const token = await getToken();
    const response = await axios.get(
      `${BASE_URL}/courier/generate/label?shipment_id=${shipment_id}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        responseType: "arraybuffer",
      }
    );
    res.setHeader("Content-Type", "application/pdf");
    res.send(response.data);
  } catch (error) {
    res.status(500).json({ error: error.response?.data || error.message });
  }
};

// 10. Generate Invoice
const generateInvoice = async (req, res) => {
  const { shipment_id } = req.body;

  try {
    const token = await getToken();
    const response = await axios.get(
      `${BASE_URL}/courier/generate/invoice?shipment_id=${shipment_id}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        responseType: "arraybuffer",
      }
    );
    res.setHeader("Content-Type", "application/pdf");
    res.send(response.data);
  } catch (error) {
    res.status(500).json({ error: error.response?.data || error.message });
  }
};

// 11. Get All NDR Shipments
const getAllNDRShipments = async (req, res) => {
  try {
    const token = await getToken();
    const response = await axios.get(`${BASE_URL}/ndr/all`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: error.response?.data || error.message });
  }
};

// 12. Get Tracking through AWB
const getTrackingByAWB = async (awb_code) => {

  try {
    const token = await getToken();
    const response = await axios.get(
      `${BASE_URL}/courier/track/awb/${awb_code}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (response?.data?.tracking_data?.shipment_track.length > 0) {
      return ({
        success: true,
        data: response.data.tracking_data.shipment_track[0].current_status
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

// 13. Get Tracking Data through Order ID
const getTrackingByOrderID = async (req, res) => {
  const { order_id } = req.params;
  try {
    const token = await getToken();
    const response = await axios.get(
      `${BASE_URL}/courier/track/order/${order_id}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: error.response?.data || error.message });
  }
};


const addPickupLocation = async (data, email) => {
  const requestData = {
    pickup_location: data.warehouseName,
    name: data.contactName,
    email,
    phone: parseInt(data.contactNo),
    address: data.addressLine1,
    address_2: data.addressLine2,
    city: data.city,
    state: data.state,
    country: "India",
    pin_code: data.pinCode
  };

  try {
    const token = await getToken();
    const response = await axios.post(
      `${BASE_URL}/settings/company/addpickup`,
      requestData,
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        }
      }
    );

    return response.data;
  } catch (error) {
    console.error('Error:', error.response ? error.response.data : error.message);
    throw error;
  }
};

const getAllPickupLocations = async () => {
  try {
    const token = await getToken();
    const response = await axios.get(
      `${BASE_URL}/settings/company/pickup`,
      {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      }
    );
    return response.data.data.shipping_address;
  } catch (error) {
    console.error('Error:', error.response ? error.response.data : error.message);
    throw error;
  }
};



module.exports = {
  createCustomOrder,

  updateOrder,
  cancelOrder,

  listCouriers,
  checkServiceability,
  requestShipmentPickup,

  createReturnOrder,

  generateManifest,

  generateLabel,
  generateInvoice,
  getAllNDRShipments,

  getTrackingByAWB,

  getTrackingByOrderID,
  addPickupLocation,
  getAllPickupLocations

};
