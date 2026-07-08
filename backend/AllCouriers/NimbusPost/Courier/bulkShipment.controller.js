if (process.env.NODE_ENV != "production") {
  require('dotenv').config();
}

const Order = require("../../../models/newOrder.model");
const Wallet = require("../../../models/wallet");
const createNimbuspostShipment = require("../../../API/Courier/nimbuspostShipmentCreation.controller");

const createShipmentFunctionNimbusPost = async (selectedServiceDetails, id, wh, walletId, finalCharges) => {
  try {
    const currentWallet = await Wallet.findById(walletId).select("balance holdAmount creditLimit");
    if (!currentWallet) {
      return { status: 400, error: 'Wallet not found' };
    }

    const order = await Order.findById(id);
    if (!order) {
      return { status: 400, error: 'Order not found' };
    }

    const charges = finalCharges === "N/A" ? 0 : parseFloat(finalCharges);

    const result = await createNimbuspostShipment({
      id,
      provider: "NimbusPost",
      finalCharges: charges,
      courierServiceName: selectedServiceDetails.courierProviderServiceName || selectedServiceDetails.name,
      priceBreakup: {
        freight: charges,
        cod: order.paymentDetails?.method === "COD" ? 30 : 0,
        gst: 0,
        total: charges
      },
      userId: order.userId,
      walletId: currentWallet._id,
      walletBalance: currentWallet.balance,
      walletHoldAmount: currentWallet.holdAmount,
      walletCreditLimit: currentWallet.creditLimit
    });

    if (result.success) {
      return { status: 201, message: "Shipment Created Successfully", awb_number: result.awb_number };
    } else {
      return { status: 400, error: result.message || "Error creating shipment", details: result };
    }
  } catch (error) {
    console.error('Error in bulk createShipmentFunctionNimbusPost:', error.message);
    return { status: 500, error: 'Internal Server Error', message: error.message };
  }
};

module.exports = { createShipmentFunctionNimbusPost };
