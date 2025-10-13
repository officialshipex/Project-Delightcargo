const axios = require("axios");
const { getAuthToken } = require("../Authorize/zipyPost.controller");
require("dotenv").config();
const Order = require("../../../models/newOrder.model");
const User = require("../../../models/User.model");
const Wallet = require("../../../models/wallet");
const CourierService = require("../../../models/CourierService.Schema");
const PickupAddress = require("../../../models/pickupAddress.model");
const { getZone } = require("../../../Rate/zoneManagementController");

const createWarehouse = async (
  userId,
  warehouseData,
  authToken,
  timestamp,
  sellerId
) => {
  try {
    // console.log("warehouse",warehouseData)
    const pickupAddress = await PickupAddress.findOne({
      userId,
      "pickupAddress.pinCode": warehouseData.pincode,
    });
    // console.log("pickup address",pickupAddress)
    if (!pickupAddress) {
      return {
        success: false,
      };
    }
    if (pickupAddress.zipypostHubId) {
      // console.log("✅ Smartship Hub already registered:", pickupAddress.smartshipHubId);
      return {
        success: true,
        warehouseId: pickupAddress.zipypostHubId,
      };
    }
    const response = await axios.post(
      "https://api.zipypost.com/create/warehouse",
      warehouseData,
      {
        headers: {
          "Content-Type": "application/json",
          authorization: authToken,
          timestamp: timestamp,
          sellerId: sellerId,
        },
      }
    );

    if (response.data.success) {
      console.log("warehouse", response.data);
      pickupAddress.zipypostHubId = response.data.warehouse_id;
      await pickupAddress.save();
      return {
        success: true,
        warehouseId: response.data.warehouse_id,
      };
    } else {
      console.error("Failed to create warehouse:", response.data.message);
      return null;
    }
  } catch (error) {
    console.error(
      "Error creating warehouse:",
      error.response?.data || error.message
    );
    return null;
  }
};

const createZipypostOrder = async (req, res) => {
  try {
    const {
      id,
      provider,
      finalCharges,
      courierServiceName,
      courier,
      estimatedDeliveryDate,
    } = req.body;

    console.log(
      "zipypost",
      id,
      provider,
      finalCharges,
      courierServiceName,
      courier,
      estimatedDeliveryDate
    );
    // Fetch order, user, wallet details
    const currentOrder = await Order.findById(id);
    if (!currentOrder)
      return res
        .status(404)
        .json({ success: false, message: "Order not found" });
    const payload = {
      source_pincode: currentOrder.pickupAddress.pinCode,
      destination_pincode: currentOrder.receiverAddress.pinCode,
      payment_type: currentOrder.paymentDetails?.method,
      order_weight: currentOrder.packageDetails.applicableWeight,
      length: currentOrder.packageDetails.volumetricWeight?.length || 0,
      breadth: currentOrder.packageDetails.volumetricWeight?.width || 0,
      height: currentOrder.packageDetails.volumetricWeight?.height || 0,
      order_value: currentOrder.paymentDetails?.amount || 0,
    };

    const user = await User.findById(currentOrder.userId);
    if (!user)
      return res
        .status(404)
        .json({ success: false, message: "User not found" });

    const currentWallet = await Wallet.findById(user.Wallet);
    if (!currentWallet)
      return res
        .status(404)
        .json({ success: false, message: "Wallet not found" });

    // Wallet balance check
    const walletHoldAmount = currentWallet?.holdAmount || 0;
    const effectiveBalance = currentWallet.balance - walletHoldAmount;
    if (effectiveBalance < finalCharges)
      return res
        .status(400)
        .json({ success: false, message: "Insufficient Wallet Balance" });
    const zone = await getZone(
      currentOrder.pickupAddress.pinCode,
      currentOrder.receiverAddress.pinCode
      // res
    );
    // console.log("zone", zone);
    if (!zone) {
      return res.status(400).json({ message: "Pincode not serviceable" });
    }
    const timestamp = Math.floor(Date.now() / 1000);
    const sellerId = process.env.ZIPYPOST_SELLER_ID;
    const token = await getAuthToken();
    
    const shipmentType = await CourierService.findOne({
      name: courierServiceName.trim(),
      provider: "ZipyPost",
    });
    // Step 1: Call serviceability function
    const serviceability = await checkZipypostServiceability(payload);
    console.log("ser", serviceability.data);
    // Step 2: Validate serviceability response
    if (
      !serviceability.data ||
      !Array.isArray(serviceability.data) ||
      serviceability.data.length === 0
    ) {
      return res
        .status(400)
        .json({ success: false, message: "No serviceability data found" });
    }

    // Step 3: Filter only Xpressbees (courier_id: 9) and Bluedart (courier_id: 10)
    const validCouriers = serviceability.data.filter(
      (svc) => svc.courier_id === 9 || svc.courier_id === 10
    );

    // Step 4: Determine courier_id based on courierServiceName
    let courier_id;
    if (courierServiceName.toLowerCase().includes("xpressbees")) courier_id = 9;
    else if (courierServiceName.toLowerCase().includes("bluedart"))
      courier_id = 10;
    else courier_id = 0;

    if (courier_id === 0) {
      return res.status(400).json({
        success: false,
        message:
          "Invalid courier name. Only Xpressbees and Bluedart supported.",
      });
    }

    // Step 5: Find the courier entry for selected courier
    const courierOptions = validCouriers.filter(
      (svc) => svc.courier_id === courier_id
    );

    // Step 6: Match mode_id based on applicable weight
    const applicableWeight = currentOrder.packageDetails.applicableWeight;
    let selectedMode = null;

    for (const option of courierOptions) {
      const slabWeight = parseFloat(option.slab);
      if (applicableWeight <= slabWeight) {
        selectedMode = option;
        break;
      }
    }

    // If no slab matched, take the last (highest slab)
    if (!selectedMode && courierOptions.length > 0) {
      selectedMode = courierOptions[courierOptions.length - 1];
    }

    if (!selectedMode) {
      return res.status(400).json({
        success: false,
        message: "Unable to determine mode_id for the courier",
      });
    }

    const mode_id = selectedMode.mode_id;
    console.log("Selected mode_id:", mode_id, "for courier:", courier_id);

    let baseName = currentOrder.pickupAddress.contactName || "Warehouse";
    baseName = baseName.substring(0, 10); // first 10 chars
    // take first 6 chars of userId
    const shortUserId = currentOrder.userId.toString().substring(0, 6);
    const warehouseName = `${baseName}-${shortUserId}-${currentOrder.pickupAddress.pinCode}`;
    // Ensure max 30 chars
    const finalWarehouseName = warehouseName.substring(0, 30);

    const warehouseData = {
      warehouseName: finalWarehouseName,
      contactName: currentOrder.pickupAddress.contactName,
      contactNumber: currentOrder.pickupAddress.phoneNumber,
      AddressLineOne: currentOrder.pickupAddress.address
        ? currentOrder.pickupAddress.address.substring(0, 45)
        : "",
      AddressLineTwo:
        currentOrder.pickupAddress.address.length > 45
          ? currentOrder.pickupAddress.address.substring(45, 90)
          : "",
      pincode: currentOrder.pickupAddress.pinCode,
      city: currentOrder.pickupAddress.city,
      //   gst: "",
      primary: true,
    };

    // Call warehouse creation
    const warehouseId = await createWarehouse(
      currentOrder.userId,
      warehouseData,
      token.authToken,
      timestamp,
      sellerId
    );
    console.log("warehouseId", warehouseId);
    if (!warehouseId.success) {
      return res.status(400).json({
        success: false,
        message:
          "Pickup pincode is not registered. Please add a pickup address first.",
      });
    }
    const totalProducts = currentOrder.productDetails.length; // number of product
    // Construct Zipypost request body
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
        // landmark: currentOrder.receiverAddress.landmark || "",
        pincode: currentOrder.receiverAddress.pinCode,
        city: currentOrder.receiverAddress.city,
      },
      billing_details: {
        full_name: currentOrder.pickupAddress.contactName,
        contact_number: currentOrder.pickupAddress.phoneNumber,
        // gstin: currentOrder.pickupAddress.gstin || "",
        address_line_one: currentOrder.pickupAddress.address
          ? currentOrder.pickupAddress.address.substring(0, 45)
          : "",
        address_line_two:
          currentOrder.pickupAddress.address.length > 45
            ? currentOrder.pickupAddress.address.substring(45, 90)
            : "",
        // company_name: currentOrder.pickupAddress.companyName || "",
        pincode: currentOrder.pickupAddress.pinCode,
        city: currentOrder.pickupAddress.city,
      },
      items: currentOrder.productDetails.map((product) => ({
        sku:
          product.sku && product.sku.length >= 3
            ? product.sku
            : `SKU${currentOrder.orderId}`, // fallback SKU
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
      mode_id: mode_id,
      //   mode_id,
    };

    console.log("request data", requestBody);

    // Call Zipypost API
    const response = await axios.post(
      "https://api.zipypost.com/create/shipment",
      requestBody,
      {
        headers: {
          "Content-Type": "application/json",
          authorization: token.authToken,
          timestamp: timestamp,
          sellerid: sellerId,
        },
      }
    );
    console.log("zipypost response", response.data);
    // Handle response
    if (response.data.success === true && response.data.booking === true) {
      const result = response.data.RESULT;

      currentOrder.status = "Booked";
      currentOrder.awb_number = result.awb;
      currentOrder.shipment_id = currentOrder.orderId;
      currentOrder.provider = result.courier;
      currentOrder.partner = "ZipyPost";
      currentOrder.shipmentCreatedAt = new Date();
      currentOrder.totalFreightCharges = finalCharges || 0;
      currentOrder.courierServiceName = courierServiceName;
      currentOrder.zone = zone.zone;
      currentOrder.estimatedDeliveryDate = estimatedDeliveryDate || "";
      currentOrder.tracking.push({
        status: "Booked",
        StatusLocation: currentOrder.pickupAddress.city,
        StatusDateTime: new Date(),
        Instructions: "Order booked successfully",
      });

      await currentOrder.save();

      // Deduct wallet balance
      await Wallet.findOneAndUpdate(
        { _id: user.Wallet, balance: { $gte: finalCharges } },
        {
          $inc: { balance: -finalCharges },
          $push: {
            transactions: {
              channelOrderId: currentOrder.orderId,
              category: "debit",
              amount: finalCharges,
              balanceAfterTransaction: currentWallet.balance - finalCharges,
              date: new Date(),
              awb_number: result.awb,
              description: "Freight Charges Applied",
            },
          },
        }
      );

      return res.status(200).json({
        success: true,
        message: "Shipment Created Successfully",
        data: result,
      });
    } else {
      return res.status(400).json({
        success: false,
        message: response.data.message || "Failed to create shipment",
      });
    }
  } catch (error) {
    console.error(
      "Error creating Zipypost shipment:",
      error.response?.data || error.message
    );
    return res.status(500).json({
      success: false,
      message: "Failed to create shipment",
      error: error.response?.data || error.message,
    });
  }
};

const checkZipypostServiceability = async (payload) => {
  try {
    const requestBody = {
      pickup_pincode: payload.source_pincode,
      drop_pincode: payload.destination_pincode,
      payment_type: payload.payment_type === "COD" ? 2 : 1, // 1 = Prepaid, 2 = COD (example)
      purchase_amount: payload.order_value || 100,
      length: payload.length || 5,
      width: payload.width || 5,
      height: payload.height || 5,
      weight: payload.order_weight || 0.5,
    };
    const timestamp = Math.floor(Date.now() / 1000);
    const sellerId = process.env.ZIPYPOST_SELLER_ID;
    const token = await getAuthToken();
    // console.log("token", token);
    const response = await axios.post(
      "https://api.zipypost.com/getservicepricing",
      requestBody,
      {
        headers: {
          "Content-Type": "application/json",
          authorization: token.authToken,
          timestamp: timestamp,
          sellerid: sellerId,
        },
      }
    );
    // console.log("Zipypost Serviceability Response:", response.data);
    const serviceabilityData = response.data?.result || [];
    const serviceable =
      response.data?.success === true && serviceabilityData.length > 0;

    return {
      success: serviceable,
      data: serviceabilityData,
    };
  } catch (err) {
    console.log("error", err.response.data.error);
    return {
      success: false,
      error: err.response?.data || err.message,
    };
  }
};

const cancelOrderZipypost = async (AWBNo) => {
  try {
    // Validate inputs
    if (!AWBNo) {
      return {
        success: false,
        message: "awb_number is required",
      };
    }

    const isCancelled = await Order.findOne({
      awb_number: AWBNo,
      status: "Cancelled",
    });

    if (isCancelled) {
      console.log("Order is already cancelled");
      return {
        error: "Order is already cancelled",
        code: 400,
        success:false
      };
    }

    // console.log("Cancel Order Request Data:", requestData);
    const timestamp = Math.floor(Date.now() / 1000);
    const sellerId = process.env.ZIPYPOST_SELLER_ID;
    const token = await getAuthToken();
    // API Call with Proper Authorization Header
    const response = await axios.get(
      `https://api.zipypost.com/cancel/shipment/${AWBNo}`,
      {
        headers: {
          authorization: token.authToken,
          timestamp: timestamp,
          sellerid: sellerId,
        },
      }
    );

    console.log("zipypost Cancel Response:", response.data);
    if (response?.data?.success) {
      await Order.updateOne(
        { awb_number: AWBNo },
        { $set: { status: "Cancelled" } }
      );
      return {
        data: response.data,
        code: 201,
      };
    } else {
      return {
        error: "Error in shipment cancellation",
        details: response.data,
        code: 400,
        success:false
      };
    }
  } catch (error) {
    console.error(
      "Error canceling shipment:",
      error.response?.data || error.message
    );
    return {
      success: false,
      message: "Failed to cancel shipment",
      error: error.response?.data || error.message,
    };
  }
};
// cancelOrderZipypost('152489850354007')

const trackOrderZipypost = async (AWBNo) => {
  const token = await getAuthToken();
  const timestamp = Math.floor(Date.now() / 1000);
  const sellerId = process.env.ZIPYPOST_SELLER_ID;
  // console.log(access_key);

  try {
    const response = await axios.get(
      `https://api.zipypost.com/track/${AWBNo}`,
      {
        headers: {
          authorization: token.authToken,
          timestamp: timestamp,
          sellerid: sellerId,
        },
      }
    );

    console.log("response data", response.data);
    console.log("respose status", response.data.result.events);
    // console.log("response status", response.data.data.scans["20726635"][0].call_logs);
    if (response.data.success === true) {
      return { success: true, data: response.data.result.events };
    }
  } catch (error) {
    console.error(
      "Error tracking shipment:",
      error.response?.data || error.message
    );
    return {
      success: false,
      error: error.response?.data || error.message,
      status: 500,
    };
  }
};
// trackOrderZipypost("76640506445")

module.exports = {
  createWarehouse,
  createZipypostOrder,
  checkZipypostServiceability,
  cancelOrderZipypost,
  trackOrderZipypost,
};
