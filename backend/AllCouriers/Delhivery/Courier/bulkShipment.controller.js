if (process.env.NODE_ENV != "production") {
  require("dotenv").config();
}
const axios = require("axios");
const { fetchBulkWaybills } = require("../Authorize/saveCourierContoller");
const url = process.env.DELHIVERY_URL;
const API_TOKEN = process.env.DEL_API_TOKEN;
const Order = require("../../../models/newOrder.model");
const crypto = require("crypto");
const Wallet = require("../../../models/wallet");
const { createClientWarehouse } = require("./couriers.controller");
const { getZone } = require("../../../Rate/zoneManagementController");
const estimatedDeliveryDate = require("../../../models/EDDMap.model");
const createShipmentFunctionDelhivery = async (
  selectedServiceDetails,
  id,
  wh,
  walletId,
  finalCharges
) => {
  const delUrl = `${url}/api/cmu/create.json`;

  try {
    const currentOrder = await Order.findById(id);
    const createClientWarehouses = await createClientWarehouse(
      currentOrder.pickupAddress
    );
    const zone = await getZone(
      currentOrder.pickupAddress.pinCode,
      currentOrder.receiverAddress.pinCode
      // res
    );
    if (!zone) {
      return res.status(400).json({ message: "Pincode not serviceable" });
    }

    const eddData = await estimatedDeliveryDate.findOne({
      courier: "Delhivery",
      serviceName: selectedServiceDetails.name,
    });
    let estimateDate = null;

    if (eddData) {
      let deliveryDays = null;

      if (
        eddData.zoneRates &&
        typeof eddData.zoneRates[zone.zone] === "number"
      ) {
        deliveryDays = eddData.zoneRates[zone.zone];
      } else if (typeof eddData[zone.zone] === "number") {
        deliveryDays = eddData[zone.zone];
      }

      if (deliveryDays) {
        estimateDate = new Date();
        estimateDate.setDate(estimateDate.getDate() + deliveryDays);
      }
    }

    const waybills = await fetchBulkWaybills(1);

    const payment_type =
      currentOrder.paymentDetails.method === "COD" ? "COD" : "Prepaid";
    const shipmentType =
      selectedServiceDetails.courierType === "Domestic (Air)"
        ? "Express"
        : "Surface";
    console.log("warehouse", selectedServiceDetails);
    const payloadData = {
      pickup_location: {
        name: wh.contactName || "Default Warehouse",
      },
      shipments: [
        {
          Waybill: waybills[0],
          country: "India",
          city: currentOrder.receiverAddress.city,
          pin: currentOrder.receiverAddress.pinCode,
          state: currentOrder.receiverAddress.state,
          order: currentOrder.orderId,
          add: currentOrder.receiverAddress.address || "Default Warehouse",
          payment_mode: payment_type,
          shipping_mode: shipmentType,
          quantity: currentOrder.productDetails
            .reduce((sum, product) => sum + product.quantity, 0)
            .toString(),
          phone: currentOrder.receiverAddress.phoneNumber,
          products_desc: currentOrder.productDetails
            .map((product) => product.name)
            .join(", "),
          total_amount: currentOrder.paymentDetails.amount,
          name: currentOrder.receiverAddress.contactName || "Default Warehouse",
          weight: currentOrder.packageDetails.applicableWeight * 1000,
          shipment_height: currentOrder.packageDetails.volumetricWeight.height,
          shipment_width: currentOrder.packageDetails.volumetricWeight.width,
          shipment_length: currentOrder.packageDetails.volumetricWeight.length,
          cod_amount:
            payment_type === "COD"
              ? `${currentOrder.paymentDetails.amount}`
              : "0",
        },
      ],
    };

    const payload = `format=json&data=${encodeURIComponent(
      JSON.stringify(payloadData)
    )}`;

    // Fetch the latest wallet details before proceeding
    let currentWallet = await Wallet.findById(walletId);
    const walletHoldAmount = currentWallet?.holdAmount || 0;
    const effectiveBalance = currentWallet.balance - walletHoldAmount;
    if (currentWallet.balance >= finalCharges) {
      const response = await axios.post(delUrl, payload, {
        headers: {
          Authorization: `Token ${API_TOKEN}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      });

      if (response.data.success) {
        const result = response.data.packages[0];

        // Update Order Details
        currentOrder.status = "Booked";
        currentOrder.cancelledAtStage = null;
        currentOrder.awb_number = result.waybill;
        currentOrder.shipment_id = `${result.refnum}`;
        currentOrder.provider = selectedServiceDetails.provider;
        currentOrder.totalFreightCharges =
          finalCharges === "N/A" ? 0 : parseInt(finalCharges);
        currentOrder.courierServiceName = selectedServiceDetails.name;
        currentOrder.shipmentCreatedAt = new Date();
        currentOrder.estimatedDeliveryDate = estimateDate;
        currentOrder.zone = zone.zone;
        currentOrder.tracking.push({
          status: "Booked",
          StatusLocation: currentOrder.pickupAddress?.city || "N/A",
          StatusDateTime: new Date(),
          Instructions: "Order booked successfully",
        });
        await currentOrder.save(); // Save the updated order

        const transaction = {
          channelOrderId: currentOrder.orderId,
          category: "debit",
          amount: finalCharges,
          date: new Date(),
          awb_number: result.waybill,
          description: "Freight Charges Applied",
          balanceAfterTransaction: null, // temporary placeholder
        };

        const updatedWallet = await Wallet.findOneAndUpdate(
          { _id: walletId, balance: { $gte: finalCharges } },
          {
            $inc: { balance: -finalCharges },
            $push: { transactions: transaction },
          },
          { new: true }
        );

        // Patch the last inserted transaction with the correct balanceAfterTransaction
        if (updatedWallet) {
          const updatedBalance = updatedWallet.balance;

          await Wallet.updateOne(
            { _id: walletId, "transactions.awb_number": result.waybill },
            {
              $set: {
                "transactions.$.balanceAfterTransaction": updatedBalance,
              },
            }
          );
        }

        return {
          status: 201,
          message: "Shipment Created Successfully",
          details: response.data,
        };
      } else {
        return {
          status: 400,
          error: "Error creating shipment",
          details: response.data,
        };
      }
    } else {
      return {
        status: 400,
        success: false,
        message: "Insufficient Wallet Balance",
      };
    }
  } catch (error) {
    console.error("Error in creating shipment:", error.message);
    return {
      status: 500,
      error: "Internal Server Error",
      message: error.message,
    };
  }
};

module.exports = { createShipmentFunctionDelhivery };
