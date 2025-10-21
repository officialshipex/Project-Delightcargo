if (process.env.NODE_ENV != "production") {
  require('dotenv').config();
}

const axios = require('axios');
// const Order=require("../../../models/orderSchema.model");
const Wallet=require("../../../models/wallet");
const {getAuthToken} = require("../Authorize/nimbuspost.controller");
const url=process.env.NIMBUSPOST_URL;

const createShipmentFunctionNimbusPost= async (selectedServiceDetails, id, wh, walletId, finalCharges) => {

  try {
    console.log("I am in bulk shipment");
    const currentOrder = await Order.findById(id);
    const currentWallet = await Wallet.findById(walletId);

    if (!currentOrder || !currentWallet) {
      throw new Error('Order or Wallet not found');
    }

    const order_items = currentOrder.Product_details.map((item) => ({
      name: item.product,
      qty: item.quantity,
      price: item.amount,
      sku: item.sku,
    }));

  
    const payment_type = currentOrder.order_type === "Cash on Delivery" ? "cod" : "prepaid";

   
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
        phone: currentOrder.shipping_details.phone,
      },
      pickup: {
        warehouse_name: wh.warehouseName,
        name: wh.contactName,
        address: `${wh.addressLine1} ${wh.addressLine2}`,
        city: wh.city,
        state: wh.state,
        pincode: wh.pinCode,
        phone: parseInt(wh.contactNo, 10),
      },
      order_items,
      courier_id: selectedServiceDetails.provider_courier_id,
    };

    const token = await getAuthToken();

    console.log(shipmentData);
    console.log(token);
    console.log(finalCharges);

    // Send shipment creation request
    const response = await axios.post(`${url}/v1/shipments`, shipmentData, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
    });
    console.log("Response",response);

    if (response.data.status) {
      const result = response.data.data;

      // Update order details
      currentOrder.status = 'Booked';
      currentOrder.cancelledAtStage = null;
      currentOrder.awb_number = result.awb_number;
      currentOrder.shipment_id = `${result.awb_number}`;
      currentOrder.service_details = selectedServiceDetails._id;
      currentOrder.freightCharges = finalCharges === "N/A" ? 0 : parseInt(finalCharges, 10);
      currentOrder.tracking = [{ stage: 'Order Booked' }];
      await currentOrder.save();

      // Deduct wallet balance and add transaction record
      const balanceToBeDeducted = finalCharges === "N/A" ? 0 : parseInt(finalCharges, 10);
      const currentBalance = currentWallet.balance - balanceToBeDeducted;
      await currentWallet.updateOne({
        $inc: { balance: -balanceToBeDeducted },
        $push: {
          transactions: {
            txnType: "Shipping",
            action: "debit",
            amount: balanceToBeDeducted,
            balanceAfterTransaction: currentBalance,
            awb_number: `${result.awb_number}`,
          },
        },
      });

      return { status: 201, message: "Shipment Created Successfully" };
    } else {
      return { status: 400, error: 'Error creating shipment', details: response.data };
    }
  } catch (error) {
    console.error('Error in creating shipment:', error.message);
    return { status: 500, error: 'Internal Server Error', message: error.message };
  }
};

module.exports ={createShipmentFunctionNimbusPost};
