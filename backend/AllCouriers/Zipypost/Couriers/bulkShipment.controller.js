const axios = require("axios");
const Order = require("../../../models/newOrder.model");
const User = require("../../../models/User.model");
const Wallet = require("../../../models/wallet");
const CourierService = require("../../../models/CourierService.Schema");
const { getAuthToken } = require("../Authorize/zipyPost.controller");
const { createWarehouse } = require("./couriers.controller");
const {getZone} = require("../../../Rate/zoneManagementController");
// const ZipyPostScanCodeMapping = require("../../utils/ZipyPostScanCodeMapping");
const estimatedDeliveryDate = require("../../../models/EDDMap.model");
const createOrderZipypost = async (
  serviceDetails,
  orderId,
  wh,
  walletId,
  charges
) => {
  try {
    console.log("➡️ Creating ZipyPost order:", orderId);

    // Fetch order, user, and wallet
    const currentOrder = await Order.findById(orderId);
    if (!currentOrder) {
      return { success: false, message: "Order not found" };
    }

    const user = await User.findById(currentOrder.userId);
    if (!user) {
      return { success: false, message: "User not found" };
    }

    const currentWallet = await Wallet.findById(walletId);
    if (!currentWallet) {
      return { success: false, message: "Wallet not found" };
    }
    // Wallet check
    const walletHoldAmount = currentWallet?.holdAmount || 0;
    const effectiveBalance = currentWallet.balance - walletHoldAmount;
    if (currentWallet.balance < charges) {
      return { success: false, message: "Insufficient Wallet Balance" };
    }

    // Zone check
    const zone = await getZone(
      currentOrder.pickupAddress.pinCode,
      currentOrder.receiverAddress.pinCode
    );
    if (!zone) {
      return { success: false, message: "Pincode not serviceable" };
    }

    const eddData = await estimatedDeliveryDate.findOne({
      courier: "ZipyPost",
      serviceName: serviceDetails.name.trim(),
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

    // Prepare ZipyPost authentication
    const timestamp = Math.floor(Date.now() / 1000);
    const sellerId = process.env.ZIPYPOST_SELLER_ID;
    const token = await getAuthToken();

    // Get courier type details
    const courierServiceName = serviceDetails.name;
    const shipmentType = await CourierService.findOne({
      name: serviceDetails.name,
      provider: "ZipyPost",
    });

    // Determine courier_id
    let courier_id = 0;
    if (courierServiceName?.toLowerCase().includes("xpressbees"))
      courier_id = 9;
    else if (courierServiceName?.toLowerCase().includes("bluedart+"))
      courier_id = 10;

    // Prepare warehouse data
    const baseName = (wh.contactName || "Warehouse").substring(0, 10);
    const shortUserId = currentOrder.userId.toString().substring(0, 6);
    const warehouseName = `${baseName}-${shortUserId}-${wh.pinCode}`.substring(
      0,
      30
    );

    const warehouseData = {
      warehouseName: warehouseName,
      contactName: currentOrder.pickupAddress.contactName,
      contactNumber: currentOrder.pickupAddress.phoneNumber,
      AddressLineOne: currentOrder.pickupAddress.address,
      AddressLineTwo: currentOrder.pickupAddress.address,
      pincode: currentOrder.pickupAddress.pinCode,
      city: currentOrder.pickupAddress.city,
      //   gst: "",
      primary: true,
    };

    const warehouseId = await createWarehouse(
      currentOrder.userId,
      warehouseData,
      token.authToken,
      timestamp,
      sellerId
    );

    if (!warehouseId.success)
      throw new Error(
        "Pickup pincode is not registered. Please add pickup address first."
      );

    // Prepare request body
    const totalProducts = currentOrder.productDetails.length;
    const requestBody = {
      order_number: currentOrder.orderId,
      purchase_amount: currentOrder.paymentDetails.amount,
      purchase_date: currentOrder.createdAt.toISOString().split("T")[0],
      billing_details_same_as_shipping: true,
      shipping_details: {
        full_name: currentOrder.receiverAddress.contactName,
        contact_number: currentOrder.receiverAddress.phoneNumber,
        customer_email:
          currentOrder.receiverAddress.email || "example@email.com",
        address_line_one: currentOrder.receiverAddress.address,
        address_line_two: currentOrder.receiverAddress.address,
        pincode: currentOrder.receiverAddress.pinCode,
        city: currentOrder.receiverAddress.city,
      },
      billing_details: {
        full_name: currentOrder.pickupAddress.contactName,
        contact_number: currentOrder.pickupAddress.phoneNumber,
        address_line_one: currentOrder.pickupAddress.address,
        address_line_two: currentOrder.pickupAddress.address,
        pincode: currentOrder.pickupAddress.pinCode,
        city: currentOrder.pickupAddress.city,
      },
      items: currentOrder.productDetails.map((product) => ({
        sku:
          product.sku && product.sku.length >= 3
            ? product.sku
            : `SKU${currentOrder.orderId}`,
        item_name: product.name,
        quantity: product.quantity || 1,
        item_weight:
          currentOrder.packageDetails.applicableWeight / totalProducts,
        item_price: product.unitPrice,
      })),
      package_length: currentOrder.packageDetails.length || 10,
      package_width: currentOrder.packageDetails.width || 10,
      package_height: currentOrder.packageDetails.height || 10,
      package_weight: currentOrder.packageDetails.applicableWeight || 0.5,
      warehouse_id: warehouseId.warehouseId,
      payment_type: currentOrder.paymentDetails.method === "COD" ? 2 : 1,
      courier_id,
      mode_id: shipmentType.courierType === "Domestic (Surface)" ? 3 : 16,
    };

    // API call
    const response = await axios.post(
      "https://api.zipypost.com/create/shipment",
      requestBody,
      {
        headers: {
          "Content-Type": "application/json",
          authorization: token.authToken,
          timestamp,
          sellerid: sellerId,
        },
      }
    );

    console.log("📦 ZipyPost response:", response.data);

    if (response.data.success && response.data.booking === true) {
      const result = response.data.RESULT;
      const awb = result.awb || "";
      //   const mappedStatus = ZipyPostScanCodeMapping[0] || "Booked";

      // Update order
      currentOrder.status = "Booked";
      currentOrder.awb_number = awb;
      currentOrder.shipment_id = currentOrder.orderId;
      currentOrder.provider = result.courier;
      currentOrder.partner = "ZipyPost";
      currentOrder.shipmentCreatedAt = new Date();
      currentOrder.totalFreightCharges = charges;
      currentOrder.courierServiceName = serviceDetails.name;
      currentOrder.zone = zone.zone;
      currentOrder.estimatedDeliveryDate = estimateDate;

      currentOrder.tracking.push({
        status: "Booked",
        StatusLocation: currentOrder.pickupAddress.city,
        StatusDateTime: new Date(),
        Instructions: "Shipment booked successfully",
      });

      await currentOrder.save();

      // Deduct wallet balance
      await Wallet.findOneAndUpdate(
        { _id: walletId, balance: { $gte: charges } },
        {
          $inc: { balance: -charges },
          $push: {
            transactions: {
              channelOrderId: currentOrder.orderId,
              category: "debit",
              amount: charges,
              balanceAfterTransaction: currentWallet.balance - charges,
              date: new Date(),
              awb_number: awb,
              description: "Freight Charges Applied",
            },
          },
        }
      );

      return {
        success: true,
        message: "Shipment Created Successfully via ZipyPost",
        data: result,
      };
    } else {
      throw new Error(
        response.data.message || "Failed to create ZipyPost shipment"
      );
    }
  } catch (error) {
    console.error(
      "❌ Error creating ZipyPost shipment:",
      error.response?.data || error.message
    );
    return {
      success: false,
      message: error.response?.data?.message || error.message,
      error: error.response?.data || error.message,
    };
  }
};

module.exports = { createOrderZipypost };
