const Order = require("../models/newOrder.model"); // Adjust the path to your model
const user = require("../models/User.model");
const pickAddress = require("../models/pickupAddress.model");
const receiveAddress = require("../models/deliveryAddress.model");
const Courier = require("../models/AllCourierSchema");
const CourierService = require("../models/CourierService.Schema");
const Plan = require("../models/Plan.model");
const Wallet = require("../models/wallet");
const Bottleneck = require("bottleneck");
const cron = require("node-cron");
const EDDMap = require("../models/EDDMap.model");
const { getZone } = require("../Rate/zoneManagementController");

const { codToBeRemitted } = require("../COD/cod.controller");
const {
  cancelShipmentforward,
  shipmentTrackingforward,
} = require("../AllCouriers/EcomExpress/Couriers/couriers.controllers");
const {
  pickup,
  cancelShipmentXpressBees,
  trackShipment,
} = require("../AllCouriers/Xpressbees/MainServices/mainServices.controller");
const {
  trackShipmentDelhivery,
} = require("../AllCouriers/Delhivery/Courier/couriers.controller");
const {
  cancelOrderDelhivery,
} = require("../AllCouriers/Delhivery/Courier/couriers.controller");
const {
  cancelShipment,
  getShipmentTracking,
} = require("../AllCouriers/Amazon/Courier/couriers.controller");
const {
  cancelOrderShreeMaruti,
  trackOrderShreeMaruti,
} = require("../AllCouriers/ShreeMaruti/Couriers/couriers.controller");
const {
  cancelSmartshipOrder,
} = require("../AllCouriers/SmartShip/Couriers/couriers.controller");
const { checkServiceabilityAll } = require("./shipment.controller");
const { calculateRateForService } = require("../Rate/calculateRateController");
const csv = require("csv-parser");
const fs = require("fs");
const { log } = require("console");
const { message } = require("../addons/utils/shippingRulesValidation");
const mongoose = require("mongoose");
const {
  cancelOrderDTDC,
  trackOrderDTDC,
} = require("../AllCouriers/DTDC/Courier/couriers.controller");
const {
  cancelVamashipOrder,
} = require("../AllCouriers/Vamaship/Couriers/couriers.controller");
const {
  cancelOrderZipypost,
} = require("../AllCouriers/Zipypost/Couriers/couriers.controller");
// Create a shipment
const newOrder = async (req, res) => {
  try {
    const {
      pickupAddress,
      receiverAddress,
      productDetails,
      packageDetails,
      paymentDetails,
      // commodityId,
    } = req.body;
    console.log(req.body);

    // Validate request data
    if (
      !pickupAddress ||
      !receiverAddress ||
      !productDetails ||
      !packageDetails ||
      !paymentDetails
      // !commodityId
    ) {
      return res.status(400).json({ error: "Alll fields are required" });
    }

    if (!["COD", "Prepaid"].includes(paymentDetails.method)) {
      return res.status(400).json({ error: "Invalid payment method" });
    }

    // Generate a unique six-digit order ID
    let orderId;
    let isUnique = false;

    while (!isUnique) {
      orderId = Math.floor(100000 + Math.random() * 900000); // Generates a random six-digit number
      const existingOrder = await Order.findOne({ orderId });
      if (!existingOrder) {
        isUnique = true;
      }
    }
    const compositeOrderId = `${req.user._id}-${orderId}`;
    // Create a new shipment
    const shipment = new Order({
      userId: req.user._id,
      orderId, // Store the generated order ID
      pickupAddress,
      receiverAddress,
      productDetails,
      packageDetails,
      paymentDetails,
      compositeOrderId,
      status: "new",
      channel: "custom",
      // commodityId: commodityId,
      tracking: [
        {
          title: "Created",
          descriptions: "Order created",
        },
      ],
    });

    // Save to the database
    await shipment.save();

    res.status(201).json({
      message: "Shipment created successfully",
      shipment,
    });
  } catch (error) {
    console.log("1111111111", error);
    res.status(400).json({ error: "All fields are required" });
  }
};
// new pick up address

const updatePackageDetails = async (req, res) => {
  try {
    const { length, width, height, weight } = req.body.details;
    const selectedOrders = req.body.selectedOrders;
    console.log("re", req.body);

    if (
      length == null ||
      width == null ||
      height == null ||
      weight == null ||
      !Array.isArray(selectedOrders)
    ) {
      return res
        .status(400)
        .json({ message: "Missing or invalid required fields." });
    }

    const validOrderIds = selectedOrders.filter((id) =>
      mongoose.Types.ObjectId.isValid(id)
    );

    if (validOrderIds.length === 0) {
      return res.status(400).json({ message: "No valid order IDs provided." });
    }

    const parsedLength = parseFloat(length);
    const parsedWidth = parseFloat(width);
    const parsedHeight = parseFloat(height);
    const parsedWeight = parseFloat(weight);

    const volumetricWeight = (parsedLength * parsedWidth * parsedHeight) / 5000;
    const applicableWeight = Math.max(parsedWeight, volumetricWeight);

    await Order.updateMany(
      { _id: { $in: validOrderIds } },
      {
        $set: {
          packageDetails: {
            deadWeight: parsedWeight,
            applicableWeight: parseFloat(applicableWeight.toFixed(2)),
            volumetricWeight: {
              length: parsedLength,
              width: parsedWidth,
              height: parsedHeight,
              calculatedWeight: parseFloat(volumetricWeight.toFixed(2)),
            },
          },
        },
      }
    );

    return res
      .status(200)
      .json({ message: "Package details updated successfully." });
  } catch (error) {
    console.error("Error updating package details:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

const newPickupAddress = async (req, res) => {
  try {
    console.log(req.body); // To log the incoming request body

    // Create a new shipment instance, where pickupAddress is a sub-document
    const shipment = new pickAddress({
      userId: req.user._id, // Assuming req.user._id is populated via authentication middleware
      pickupAddress: {
        contactName: req.body.contactName,
        email: req.body.email,
        phoneNumber: req.body.phoneNumber,
        address: req.body.address || "", // Default to empty string if not provided
        pinCode: req.body.pinCode,
        city: req.body.city,
        state: req.body.state,
      },
    });

    // Save the shipment with the pickup address
    await shipment.save();

    res.status(201).json({
      success: true,
      message: "Pickup address saved successfully!",
      data: shipment,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Server error while saving pickup address",
    });
  }
};

const newReciveAddress = async (req, res) => {
  try {
    // console.log(req.body); // To log the incoming request body

    // Create a new shipment instance, where receiverAddress is a sub-document
    const shipment = new receiveAddress({
      userId: req.user._id, // Assuming req.user._id is populated via authentication middleware
      receiverAddress: {
        contactName: req.body.contactName,
        email: req.body.email,
        phoneNumber: req.body.phoneNumber,
        address: req.body.address || "", // Default to empty string if not provided
        pinCode: req.body.pinCode,
        city: req.body.city,
        state: req.body.state,
      },
    });

    // console.log(shipment)

    // Save the shipment with the receiver address
    await shipment.save();

    res.status(201).json({
      success: true,
      message: "Receiver address saved successfully!",
      data: shipment,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Server error while saving receiver address",
    });
  }
};

const deletePickupAddress = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user._id;

    // Find the pickup address and ensure it belongs to the user
    const pickupAddress = await pickAddress.findOne({ _id: id, userId });

    if (!pickupAddress) {
      return res
        .status(404)
        .json({ message: "Pickup address not found or unauthorized." });
    }

    // Delete the address
    await pickAddress.deleteOne({ _id: id });

    res.status(200).json({ message: "Pickup address deleted successfully." });
  } catch (error) {
    console.error("Error deleting pickup address:", error);
    res.status(500).json({ message: "Internal server error." });
  }
};

const getOrders = async (req, res) => {
  try {
    const {
      id,
      status,
      searchQuery,
      orderId,
      awbNumber,
      trackingId,
      paymentType,
      startDate,
      endDate,
    } = req.query;
    let userId;
    if (id) {
      userId = id;
    } else {
      userId = req.user?._id || req.employee?._id;
    }

    // console.log("userId",userId)

    const page = parseInt(req.query.page) || 1;
    const limitQuery = req.query.limit;
    const limit =
      limitQuery === "All" || !limitQuery ? null : parseInt(limitQuery);
    const skip = limit ? (page - 1) * limit : 0;

    const andConditions = [{ userId }];

    if (status && status !== "All") {
      const statusArray = Array.isArray(status)
        ? status
        : status.split(",").map((s) => s.trim());

      andConditions.push({ status: { $in: statusArray } });
    }

    if (searchQuery) {
      andConditions.push({
        $or: [
          {
            "receiverAddress.contactName": {
              $regex: searchQuery,
              $options: "i",
            },
          },
          { "receiverAddress.email": { $regex: searchQuery, $options: "i" } },
          {
            "receiverAddress.phoneNumber": {
              $regex: searchQuery,
              $options: "i",
            },
          },
        ],
      });
    }

    if (orderId) {
      const orderIdNum = parseInt(orderId);
      if (!isNaN(orderIdNum)) {
        andConditions.push({ orderId: orderIdNum });
      }
    }
    if (awbNumber) {
      andConditions.push({ awb_number: { $regex: awbNumber, $options: "i" } });
    }
    if (trackingId) {
      andConditions.push({ trackingId: { $regex: trackingId, $options: "i" } });
    }
    if (req.query.courierServiceName) {
      andConditions.push({ courierServiceName: req.query.courierServiceName });
    }

    if (paymentType) {
      andConditions.push({ "paymentDetails.method": paymentType });
    }

    if (startDate && endDate) {
      const start = new Date(startDate);
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      andConditions.push({ createdAt: { $gte: start, $lte: end } });
    }

    if (req.query.pickupContactName) {
      andConditions.push({
        "pickupAddress.contactName": req.query.pickupContactName,
      });
    }

    const filter = { $and: andConditions };

    const totalCount = await Order.countDocuments(filter);

    let query = Order.find(filter).sort({ createdAt: -1 });
    if (limit) query = query.skip(skip).limit(limit);

    const orders = await query.lean();
    // console.log(orders)
    const totalPages = limit ? Math.ceil(totalCount / limit) : 1;

    const allCourierServices = await Order.aggregate([
      { $match: { userId } },
      {
        $group: {
          _id: "$courierServiceName",
        },
      },
      {
        $project: {
          _id: 0,
          courierServiceName: "$_id",
        },
      },
    ]);

    // Fetch all unique pickup locations for the user (not filtered)
    const allPickupLocations = await Order.aggregate([
      { $match: { userId } },
      {
        $group: {
          _id: {
            contactName: "$pickupAddress.contactName",
            // Optionally, you can add _id: "$pickupAddress._id" if needed
          },
          address: { $first: "$pickupAddress.address" },
          phoneNumber: { $first: "$pickupAddress.phoneNumber" },
          email: { $first: "$pickupAddress.email" },
          pinCode: { $first: "$pickupAddress.pinCode" },
          city: { $first: "$pickupAddress.city" },
          state: { $first: "$pickupAddress.state" },
        },
      },
      {
        $project: {
          _id: 0,
          contactName: "$_id.contactName",
          address: 1,
          phoneNumber: 1,
          email: 1,
          pinCode: 1,
          city: 1,
          state: 1,
        },
      },
    ]);

    res.json({
      orders,
      totalPages,
      totalCount,
      currentPage: page,
      pickupLocations: allPickupLocations,
      courierServices: allCourierServices.map((c) => c.courierServiceName),
    });
  } catch (error) {
    console.error("Error fetching paginated orders:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

const getShippingOrders = async (req, res) => {
  try {
    const {
      id,
      status,
      searchQuery,
      orderId,
      awbNumber,
      trackingId,
      paymentType,
      startDate,
      endDate,
    } = req.query;
    // console.log("re",req.query)
    let userId;
    if (id) {
      userId = id;
    } else {
      userId = req.user?._id || req.employee?._id;
    }

    const page = parseInt(req.query.page) || 1;
    const limitQuery = req.query.limit;
    const limit =
      limitQuery === "All" || !limitQuery ? null : parseInt(limitQuery);
    const skip = limit ? (page - 1) * limit : 0;

    const andConditions = [{ userId }];

    // ✅ Exclude "New" and "Cancelled" orders
    andConditions.push({
      status: { $nin: ["new", "Cancelled"] },
    });

    // If specific statuses are requested, combine with exclusion rule
    if (status && status !== "All") {
      const statusArray = Array.isArray(status)
        ? status
        : status.split(",").map((s) => s.trim());

      andConditions.push({
        status: { $in: statusArray, $nin: ["new", "Cancelled"] },
      });
    }

    if (searchQuery) {
      andConditions.push({
        $or: [
          {
            "receiverAddress.contactName": {
              $regex: searchQuery,
              $options: "i",
            },
          },
          { "receiverAddress.email": { $regex: searchQuery, $options: "i" } },
          {
            "receiverAddress.phoneNumber": {
              $regex: searchQuery,
              $options: "i",
            },
          },
        ],
      });
    }

    if (orderId) {
      const orderIdNum = parseInt(orderId);
      if (!isNaN(orderIdNum)) {
        andConditions.push({ orderId: orderIdNum });
      }
    }

    if (awbNumber) {
      andConditions.push({ awb_number: { $regex: awbNumber, $options: "i" } });
    }

    if (trackingId) {
      andConditions.push({ trackingId: { $regex: trackingId, $options: "i" } });
    }

    if (req.query.courierServiceName) {
      andConditions.push({ courierServiceName: req.query.courierServiceName });
    }

    if (paymentType) {
      andConditions.push({ "paymentDetails.method": paymentType });
    }

    if (startDate && endDate) {
      const start = new Date(startDate);
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      andConditions.push({ createdAt: { $gte: start, $lte: end } });
    }

    if (req.query.pickupContactName) {
      andConditions.push({
        "pickupAddress.contactName": req.query.pickupContactName,
      });
    }

    const filter = { $and: andConditions };

    const totalCount = await Order.countDocuments(filter);

    let query = Order.find(filter).sort({ createdAt: -1 });
    if (limit) query = query.skip(skip).limit(limit);

    const orders = await query.lean();
    const totalPages = limit ? Math.ceil(totalCount / limit) : 1;

    const allCourierServices = await Order.aggregate([
      { $match: { userId } },
      {
        $group: {
          _id: "$courierServiceName",
        },
      },
      {
        $project: {
          _id: 0,
          courierServiceName: "$_id",
        },
      },
    ]);

    const allPickupLocations = await Order.aggregate([
      { $match: { userId } },
      {
        $group: {
          _id: {
            contactName: "$pickupAddress.contactName",
          },
          address: { $first: "$pickupAddress.address" },
          phoneNumber: { $first: "$pickupAddress.phoneNumber" },
          email: { $first: "$pickupAddress.email" },
          pinCode: { $first: "$pickupAddress.pinCode" },
          city: { $first: "$pickupAddress.city" },
          state: { $first: "$pickupAddress.state" },
        },
      },
      {
        $project: {
          _id: 0,
          contactName: "$_id.contactName",
          address: 1,
          phoneNumber: 1,
          email: 1,
          pinCode: 1,
          city: 1,
          state: 1,
        },
      },
    ]);

    res.json({
      orders,
      totalPages,
      totalCount,
      currentPage: page,
      pickupLocations: allPickupLocations,
      courierServices: allCourierServices.map((c) => c.courierServiceName),
    });
  } catch (error) {
    console.error("Error fetching active orders:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

const getOrdersByNdrStatus = async (req, res) => {
  try {
    const { id } = req.query;
    let userId;
    if (id) {
      userId = id;
    } else {
      userId = req.user._id;
    }

    const page = parseInt(req.query.page) || 1;
    const limitQuery = req.query.limit;
    const limit =
      limitQuery === "All" || !limitQuery ? null : parseInt(limitQuery);
    const skip = limit ? (page - 1) * limit : 0;
    const status = req.query.status;

    const andConditions = [{ userId }];
    if (status && status !== "All") {
      andConditions.push({ ndrStatus: status });
    }

    // Add filters like in getOrders
    if (req.query.searchQuery) {
      andConditions.push({
        $or: [
          {
            "receiverAddress.contactName": {
              $regex: req.query.searchQuery,
              $options: "i",
            },
          },
          {
            "receiverAddress.email": {
              $regex: req.query.searchQuery,
              $options: "i",
            },
          },
          {
            "receiverAddress.phoneNumber": {
              $regex: req.query.searchQuery,
              $options: "i",
            },
          },
        ],
      });
    }
    if (req.query.orderId) {
      const orderIdNum = parseInt(req.query.orderId);
      if (!isNaN(orderIdNum)) {
        andConditions.push({ orderId: orderIdNum });
      }
    }
    if (req.query.awbNumber) {
      andConditions.push({
        awb_number: { $regex: req.query.awbNumber, $options: "i" },
      });
    }
    if (req.query.trackingId) {
      andConditions.push({
        trackingId: { $regex: req.query.trackingId, $options: "i" },
      });
    }
    if (req.query.courierServiceName) {
      andConditions.push({ courierServiceName: req.query.courierServiceName });
    }
    if (req.query.paymentType) {
      andConditions.push({ "paymentDetails.method": req.query.paymentType });
    }
    if (req.query.startDate && req.query.endDate) {
      const start = new Date(req.query.startDate);
      const end = new Date(req.query.endDate);
      end.setHours(23, 59, 59, 999);
      andConditions.push({ createdAt: { $gte: start, $lte: end } });
    }
    if (req.query.pickupContactName) {
      andConditions.push({
        "pickupAddress.contactName": req.query.pickupContactName,
      });
    }

    const filter = { $and: andConditions };

    const totalCount = await Order.countDocuments(filter);

    let query = Order.find(filter).sort({
      "ndrReason.date": -1,
      createdAt: -1,
    });

    if (limit) query = query.skip(skip).limit(limit);

    const orders = await query.lean();
    const totalPages = limit ? Math.ceil(totalCount / limit) : 1;

    // Add these two aggregations:
    const allCourierServices = await Order.aggregate([
      { $match: { userId } },
      { $group: { _id: "$courierServiceName" } },
      { $project: { _id: 0, courierServiceName: "$_id" } },
    ]);
    const allPickupLocations = await Order.aggregate([
      { $match: { userId } },
      {
        $group: {
          _id: { contactName: "$pickupAddress.contactName" },
          address: { $first: "$pickupAddress.address" },
          phoneNumber: { $first: "$pickupAddress.phoneNumber" },
          email: { $first: "$pickupAddress.email" },
          pinCode: { $first: "$pickupAddress.pinCode" },
          city: { $first: "$pickupAddress.city" },
          state: { $first: "$pickupAddress.state" },
        },
      },
      {
        $project: {
          _id: 0,
          contactName: "$_id.contactName",
          address: 1,
          phoneNumber: 1,
          email: 1,
          pinCode: 1,
          city: 1,
          state: 1,
        },
      },
    ]);

    res.json({
      orders,
      totalPages,
      totalCount,
      currentPage: page,
      pickupLocations: allPickupLocations,
      courierServices: allCourierServices.map((c) => c.courierServiceName),
    });
  } catch (error) {
    console.error("Error fetching paginated orders:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

const setPrimaryPickupAddress = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user._id;

    // 1. Check if the pickup address exists and belongs to the user
    const pickupAddress = await pickAddress.findOne({ _id: id, userId });
    if (!pickupAddress) {
      return res
        .status(404)
        .json({ message: "Pickup address not found or unauthorized." });
    }

    // 2. Set all other pickup addresses' isPrimary to false
    await pickAddress.updateMany({ userId }, { $set: { isPrimary: false } });

    // 3. Set the selected address as primary
    pickupAddress.isPrimary = true;
    await pickupAddress.save();

    res.status(200).json({
      message: "Primary pickup address updated successfully.",
      pickupAddress,
    });
  } catch (error) {
    console.error("Error setting primary pickup address:", error);
    res.status(500).json({ message: "Internal server error." });
  }
};
const updatePickupAddress = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user._id; // Ensure you have authentication middleware that sets req.user

    console.log("Updating pickup address ID:", id);

    const { contactName, email, phoneNumber, address, pinCode, city, state } =
      req.body;

    const pickupAddress = await pickAddress.findOne({ _id: id, userId });

    if (!pickupAddress) {
      return res
        .status(404)
        .json({ message: "Pickup address not found or unauthorized." });
    }

    // Update fields
    pickupAddress.pickupAddress.contactName = contactName;
    pickupAddress.pickupAddress.email = email;
    pickupAddress.pickupAddress.phoneNumber = phoneNumber;
    pickupAddress.pickupAddress.address = address;
    pickupAddress.pickupAddress.pinCode = pinCode;
    pickupAddress.pickupAddress.city = city;
    pickupAddress.pickupAddress.state = state;

    await pickupAddress.save();

    res.status(200).json({
      message: "Pickup address updated successfully.",
      pickupAddress,
    });
  } catch (error) {
    console.error("Error updating pickup address:", error);
    res.status(500).json({ message: "Internal server error." });
  }
};

const updateOrder = async (req, res) => {
  try {
    const { orderId } = req.params;
    console.log("orderId", orderId);
    const { pickupAddress, receiverAddress, paymentDetails, packageDetails } =
      req.body;

    console.log(req.body);
    if (!mongoose.Types.ObjectId.isValid(orderId)) {
      return res.status(400).json({ message: "Invalid orderId format." });
    }

    const existingOrder = await Order.findById(orderId);
    if (!existingOrder) {
      return res.status(404).json({ message: "Order not found." });
    }
    //   if (!req.body.paymentDetails || !req.body.paymentDetails.amount) {
    //     return res.status(400).json({ error: "paymentDetails and amount are required" });
    // }
    // console.log(pickupAddress)

    const updateFields = {};

    // Update pickupAddress if provided
    if (pickupAddress) {
      updateFields.pickupAddress = {
        contactName:
          pickupAddress.contactName || existingOrder.pickupAddress.contactName,
        phoneNumber:
          pickupAddress.phoneNumber || existingOrder.pickupAddress.phoneNumber,
        email: pickupAddress.email || existingOrder.pickupAddress.email,
        address: pickupAddress.address || existingOrder.pickupAddress.address,
        city: pickupAddress.city || existingOrder.pickupAddress.city,
        state: pickupAddress.state || existingOrder.pickupAddress.state,
        pinCode: pickupAddress.pinCode || existingOrder.pickupAddress.pinCode,
      };
    }

    // Update receiverAddress if provided
    if (receiverAddress) {
      updateFields.receiverAddress = {
        contactName:
          receiverAddress.contactName ||
          existingOrder.receiverAddress.contactName,
        phoneNumber:
          receiverAddress.phoneNumber ||
          existingOrder.receiverAddress.phoneNumber,
        email: receiverAddress.email || existingOrder.receiverAddress.email,
        address:
          receiverAddress.address || existingOrder.receiverAddress.address,
        city: receiverAddress.city || existingOrder.receiverAddress.city,
        state: receiverAddress.state || existingOrder.receiverAddress.state,
        pinCode:
          receiverAddress.pinCode || existingOrder.receiverAddress.pinCode,
      };
    }

    // Ensure paymentDetails exist before updating
    if (paymentDetails) {
      updateFields.paymentDetails = {
        method: paymentDetails.method || existingOrder.paymentDetails.method,
        amount: paymentDetails.amount || existingOrder.paymentDetails.amount,
      };
    }

    // Ensure packageDetails exist before updating
    if (packageDetails) {
      updateFields.packageDetails = {
        deadWeight:
          packageDetails.deadWeight || existingOrder.packageDetails.deadWeight,
        applicableWeight:
          packageDetails.applicableWeight ||
          existingOrder.packageDetails.applicableWeight,
        volumetricWeight: {
          length:
            packageDetails.volumetricWeight?.length ||
            existingOrder.packageDetails.volumetricWeight.length,
          width:
            packageDetails.volumetricWeight?.width ||
            existingOrder.packageDetails.volumetricWeight.width,
          height:
            packageDetails.volumetricWeight?.height ||
            existingOrder.packageDetails.volumetricWeight.height,
        },
      };
    }

    // Update order in the database
    const updatedOrder = await Order.findByIdAndUpdate(
      orderId,
      { $set: updateFields },
      { new: true, runValidators: true }
    );

    if (!updatedOrder) {
      return res.status(404).json({ message: "Order not found." });
    }

    res.status(200).json({
      message: "Order updated successfully.",
      order: updatedOrder,
    });
  } catch (error) {
    console.error("Error updating order:", error);
    res.status(500).json({ message: "Internal server error." });
  }
};
const getOrdersById = async (req, res) => {
  const { id } = req.params;
  // console.log("Received ID:", id);

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ error: "Invalid order ID format" });
  }

  try {
    const order = await Order.findById(id);
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }
    res.status(200).json(order);
  } catch (err) {
    console.error("Error fetching order:", err);
    res.status(500).json({ message: "Server error" });
  }
};

const updatedStatusOrders = async (req, res) => {
  try {
    // console.log(req.body.id);

    // Ensure order ID is provided
    if (!req.body) {
      return res.status(400).json({ error: "Order ID is required" });
    }

    // Update order status
    if (!mongoose.Types.ObjectId.isValid(req.body.id)) {
      return res.status(400).json({ error: "Invalid order ID format" });
    }

    const order = await Order.findByIdAndUpdate(
      req.body.id,
      {
        $set: { status: "new" },
        $push: {
          tracking: {
            title: "Clone",
            descriptions: "Clone Order by user",
          },
        },
      },
      { new: true }
    );

    // If order not found
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    // Respond with updated order
    res.status(200).json({
      success: true,
      message: "Clone Order sucessfully",
      order,
    });
  } catch (error) {
    console.error("Error updating order status:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
};

const getpickupAddress = async (req, res) => {
  try {
    const pickupAddresses = await pickAddress.find({ userId: req.user._id });

    if (!pickupAddresses.length) {
      return res.status(404).json({ message: "No pickup addresses found" });
    }

    res.status(200).json({ success: true, data: pickupAddresses });
  } catch (error) {
    console.error("Error fetching pickup addresses:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
};

const getreceiverAddress = async (req, res) => {
  try {
    const receiverAddresses = await receiveAddress.find({
      userId: req.user._id,
    });

    if (!receiverAddresses.length) {
      return res
        .status(404)
        .json({ success: false, message: "No receiver addresses found" });
    }

    res.status(200).json({ success: true, data: receiverAddresses });
  } catch (error) {
    console.error("Error fetching receiver addresses:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
};

const ShipeNowOrder = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    const plan = await Plan.findOne({ userId: order.userId });
    const users = await user.findOne({ _id: order.userId });
    const userWallet = await Wallet.findOne({ _id: users.Wallet });

    // ✅ fetch EDDMap
    const EDDRates = await EDDMap.find();

    // ✅ enabled courier services
    const services = await CourierService.find({ status: "Enable" });
    const enabledServices = [];

    for await (const srvc of services) {
      const provider = await Courier.findOne({
        courierProvider: srvc.provider,
      });
      if (provider?.status === "Enable") {
        enabledServices.push(srvc);
      }
    }

    const availableServices = await Promise.all(
      enabledServices.map(async (item) => {
        let result = await checkServiceabilityAll(
          item,
          order._id,
          order.pickupAddress.pinCode
        );
        if (result && result.success) {
          return { item };
        }
      })
    );
    // console.log("availa", availableServices);

    const filteredServices = availableServices.filter(Boolean);
// console.log("filteredServicess",filteredServices)
    // ✅ calculate zone based on pincodes
    const zone = await getZone(
      order.pickupAddress.pinCode,
      order.receiverAddress.pinCode
    );

    const payload = {
      pickupPincode: order.pickupAddress.pinCode,
      deliveryPincode: order.receiverAddress.pinCode,
      length: order.packageDetails.volumetricWeight.length,
      breadth: order.packageDetails.volumetricWeight.width,
      height: order.packageDetails.volumetricWeight.height,
      weight: order.packageDetails.applicableWeight,
      cod: order.paymentDetails.method === "COD" ? "Yes" : "No",
      valueInINR: order.paymentDetails.amount,
      userID: req.user._id,
      filteredServices,
      rateCardType: plan.planName,
    };

    let rates = await calculateRateForService(payload);
    // console.log("rates",rates)

    // ✅ normalize helper
    const normalize = (str) => str?.toLowerCase().replace(/\s+/g, "").trim();

    // ✅ Build updatedRates only for serviceable couriers
    const updatedRates = filteredServices
      .map((service) => {
        const matchedRate = rates.find(
          (rate) =>
            normalize(rate.courierServiceName) === normalize(service.item.name)
        );

        if (!matchedRate) return null; // ❌ skip if no rate (not serviceable)

        const matchedEDD = EDDRates.find(
          (edd) => normalize(edd.serviceName) === normalize(service.item.name)
        );

        let estimatedDeliveryDate = null;
        if (matchedEDD && matchedEDD.zoneRates) {
          const zoneKey = zone.zone; // already like "zoneA"
          const days = matchedEDD.zoneRates[zoneKey];
          if (days) {
            const eddDate = new Date();
            eddDate.setDate(eddDate.getDate() + days);
            estimatedDeliveryDate = eddDate;
          }
        }

        return {
          ...matchedRate,
          provider: service.item.provider,
          courierType: service.item.courierType,
          courier: service.item?.courier,
          serviceName: service.item.name,
          estimatedDeliveryDate,
        };
      })
      .filter(Boolean); // remove nulls

    res.status(201).json({
      success: true,
      order,
      updatedRates, // ✅ only serviceable with rates
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Server error" });
  }
};

const pincodeData = [];

fs.createReadStream("data/pincodes.csv")
  .pipe(csv())
  .on("data", (row) => {
    pincodeData.push(row);
    // console.log(row)
  })
  .on("end", () => {
    console.log("CSV file successfully loaded.");
  });

const getPinCodeDetails = async (req, res) => {
  const { pincode } = req.params;
  // console.log(pincode);
  const foundEntry = pincodeData.find((entry) => entry.pincode === pincode);
  // console.log(pincodeData)

  if (foundEntry) {
    res.json({ city: foundEntry.city, state: foundEntry.state });
  } else {
    res.status(404).json({ error: "Pincode not found" });
  }
};

const cancelOrdersAtNotShipped = async (req, res) => {
  const { orderId } = req.body;
  // console.log(orderData)
  try {
    const currentOrder = await Order.findByIdAndDelete({ _id: orderId });

    res.status(201).json({ message: "Order delete successfully" });
  } catch (error) {
    console.error("Error canceling orders:", {
      // error,
      // orders: ordersToBeCancelled.map((order) => order._id),
    });
    res
      .status(500)
      .send({ error: "An error occurred while cancelling orders." });
  }
};
const cancelOrdersAtBooked = async (req, res) => {
  const allOrders = req.body;
  // console.log(allOrders);
  try {
    const users = await user.findOne({ _id: allOrders.userId });
    // console.log(users)
    const currentWallet = await Wallet.findById({ _id: users.Wallet });

    const currentOrder = await Order.findById({ _id: allOrders._id });
    if (currentOrder.awb_number === "N/A" || !currentOrder.awb_number) {
      return res
        .status(400)
        .send({ error: "Order cannot be cancelled missing awb_number" });
    }
    if (currentOrder.status === "Cancelled") {
      return res.status(400).send({ error: "Order is already Cancelled" });
    }
    const cancellableStatuses = ["Ready To Ship", "Booked", "Not Picked"];

    if (!cancellableStatuses.includes(currentOrder.status)) {
      return res.status(400).send({ error: "Order is not ready to Cancelled" });
    }

    if (currentOrder.provider === "Xpressbeesss") {
      const result = await cancelShipmentXpressBees(currentOrder.awb_number);
      if (result.error) {
        return res.status(400).send({ error: "Failed to cancel order" });
      }
    } else if (currentOrder.provider === "Shiprocket") {
      const result = await cancelOrder(currentOrder.awb_number);
      if (!result.success) {
        return {
          error: "Failed to cancel shipment with Shiprocket",
          details: result,
          orderId: currentOrder._id,
        };
      } else if (currentOrder.provider === "Nimuspost") {
        const result = await cancelShipmentXpressBees(currentOrder.awb_number);
        if (result.error) {
          return res.status(400).send({ error: "Failed to cancel order" });
        }
      }
    } else if (currentOrder.provider === "Delhivery") {
      // console.log("I am in it");
      const result = await cancelOrderDelhivery(currentOrder.awb_number);

      if (result.error) {
        return res.status(400).json({
          error: result?.error || "Failed to cancel shipment with Delhivery",
          details: result,
          orderId: currentOrder._id,
        });
      }
    } else if (currentOrder.provider === "Shree Maruti") {
      const result = await cancelOrderShreeMaruti(currentOrder.orderId);
      // console.log("shreemaruti",result)
      if (result.error) {
        // console.log("shree",result)
        return res.status(400).json({
          error: "Failed to cancel shipment with ShreeMaruti",
          details: result,
          orderId: currentOrder._id,
        });
      }
    } else if (currentOrder.provider === "Dtdc") {
      const result = await cancelOrderDTDC(currentOrder.awb_number);
      if (result.error) {
        return res.status(400).send({ error: result.error });
      }
    } else if (currentOrder.provider === "EcomExpress") {
      const result = await cancelShipmentforward(currentOrder.awb_number);
      if (result.error) {
        return res.status(400).send({ error: result.error });
      }
    } else if (currentOrder.provider === "Amazon Shipping") {
      const result = await cancelShipment(currentOrder.shipment_id);
      if (result.error) {
        return res.status(400).send({ error: result.error });
      }
    } else if (currentOrder.provider === "Smartship") {
      const result = await cancelSmartshipOrder(currentOrder.orderId);
      if (result.error) {
        return res.status(400).send({ error: result.error });
      }
    } else if (currentOrder.provider === "Vamaship") {
      const result = await cancelVamashipOrder(currentOrder.shipment_id);
      if (result.error) {
        return res.status(400).send({ error: result.error });
      }
    } else if (currentOrder.partner === "ZipyPost") {
      const result = await cancelOrderZipypost(currentOrder.awb_number);
      if (result.error) {
        return res.status(400).send({ error: result.error });
      }
    } else {
      return {
        error: "Unsupported courier provider",
        orderId: currentOrder._id,
      };
    }

    // currentOrder.status = "Not-Shipped";
    // currentOrder.cancelledAtStage = "Booked";
    currentOrder.tracking.push({
      status: "Cancelled",
      StatusLocation: "",
      StatusDateTime: new Date(),
      Instructions: "Order cancelled successfully",
    });

    let balanceTobeAdded =
      allOrders.totalFreightCharges == "N/A"
        ? 0
        : parseInt(allOrders.totalFreightCharges);
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const updatedWallet = await Wallet.findOneAndUpdate(
        { _id: currentWallet._id },
        { $inc: { balance: balanceTobeAdded } },
        { new: true, session }
      );

      await Wallet.updateOne(
        { _id: updatedWallet._id },
        {
          $push: {
            transactions: {
              channelOrderId: currentOrder.orderId || null,
              category: "credit",
              amount: balanceTobeAdded,
              balanceAfterTransaction: updatedWallet.balance,
              date: new Date(),
              awb_number: allOrders.awb_number || "",
              description: `Freight Charges Received`,
            },
          },
        },
        { session }
      );

      await session.commitTransaction();
      await currentOrder.save({ session }); // ✅ Save order with updated tracking
      session.endSession();
    } catch (err) {
      await session.abortTransaction();
      session.endSession();
      throw err;
    }

    // console.log("hii")
    res.status(201).send({
      success: true,
    });
  } catch (error) {
    console.error("Error cancelling orders:", error);
    res
      .status(500)
      .send({ error: "An error occurred while cancelling orders." });
  }
};

// setInterval(trackOrders, 60 * 100000);
const passbook = async (req, res) => {
  try {
    const { id } = req.query;
    const userId = id || req.user._id;

    const {
      fromDate,
      toDate,
      category,
      awbNumber,
      orderId,
      page = 1,
      limit = 20,
    } = req.query;

    if (!userId) {
      return res.status(400).json({ message: "User ID is required" });
    }

    const currentUser = await user.findById(userId);
    if (!currentUser || !currentUser.Wallet) {
      return res.status(404).json({ message: "Wallet not found" });
    }

    const transactionMatchStage = {};

    // Date filter
    if (fromDate && toDate) {
      const start = new Date(new Date(fromDate).setHours(0, 0, 0, 0));
      const end = new Date(new Date(toDate).setHours(23, 59, 59, 999));
      transactionMatchStage["wallet.transactions.date"] = {
        $gte: start,
        $lte: end,
      };
    }

    if (category) {
      transactionMatchStage["wallet.transactions.category"] = category;
    }

    if (awbNumber) {
      transactionMatchStage["wallet.transactions.awb_number"] = awbNumber;
    }

    if (orderId) {
      transactionMatchStage["wallet.transactions.channelOrderId"] = orderId;
    }

    const parsedLimit =
      typeof limit === "string" && limit.toLowerCase() === "all"
        ? null
        : Number(limit);

    const finalLimit =
      parsedLimit === null || isNaN(parsedLimit) ? null : parsedLimit;

    const skip = finalLimit ? (Number(page) - 1) * finalLimit : 0;

    const basePipeline = [
      { $match: { _id: currentUser._id } },
      {
        $lookup: {
          from: "wallets",
          localField: "Wallet",
          foreignField: "_id",
          as: "wallet",
        },
      },
      { $unwind: "$wallet" },
      { $unwind: "$wallet.transactions" },
      { $match: transactionMatchStage },

      // Lookup courierServiceName from orders using awb_number
      {
        $lookup: {
          from: "neworders",
          localField: "wallet.transactions.awb_number",
          foreignField: "awb_number",
          as: "orderInfo",
        },
      },
      {
        $addFields: {
          courierServiceName: {
            $arrayElemAt: ["$orderInfo.courierServiceName", 0],
          },
          provider: { $arrayElemAt: ["$orderInfo.provider", 0] },
        },
      },

      {
        $project: {
          _id: 0,
          category: "$wallet.transactions.category",
          amount: "$wallet.transactions.amount",
          balanceAfterTransaction:
            "$wallet.transactions.balanceAfterTransaction",
          date: "$wallet.transactions.date",
          awb_number: "$wallet.transactions.awb_number",
          orderId: "$wallet.transactions.channelOrderId",
          description: "$wallet.transactions.description",
          courierServiceName: 1,
          provider: 1,
        },
      },
      { $sort: { date: -1 } },
    ];

    const [transactions, totalCountResult] = await Promise.all([
      finalLimit === null
        ? user.aggregate(basePipeline)
        : user.aggregate([
            ...basePipeline,
            { $skip: skip },
            { $limit: finalLimit },
          ]),
      user.aggregate([...basePipeline, { $count: "total" }]),
    ]);

    const totalCount = totalCountResult[0]?.total || 0;
    const totalPages = finalLimit ? Math.ceil(totalCount / finalLimit) : 1;

    return res.status(200).json({
      message: "Passbook fetched successfully",
      results: transactions,
      totalCount,
      page: totalPages,
      currentPage: Number(page),
      limit: finalLimit ?? "All",
    });
  } catch (error) {
    console.error("Error fetching passbook:", error);
    return res.status(500).json({
      message: "Internal server error",
      error: error.message,
    });
  }
};

const getUser = async (req, res) => {
  try {
    const userId = req.user._id;

    if (!userId) {
      return res.status(400).json({ message: "User ID is required" });
    }
    const users = await user.findOne({ _id: userId });
    if (!users) {
      return res.status(400).json({ message: "User Not found" });
    }
    return res.status(200).json(users);
  } catch (error) {
    return res.status(400).json({ message: "User not found" });
  }
};
const deleteOrder = async (req, res) => {
  try {
    const orderId = req.user._id;

    // Validate orderId
    if (!orderId) {
      return res
        .status(400)
        .json({ success: false, message: "Order ID is required." });
    }

    // Find and delete the order
    const deletedOrder = await Order.findByIdAndDelete(orderId);

    if (!deletedOrder) {
      return res
        .status(404)
        .json({ success: false, message: "Order not found." });
    }

    res
      .status(200)
      .json({ success: true, message: "Order deleted successfully." });
  } catch (error) {
    console.error("Error deleting order:", error);
    res.status(500).json({ success: false, message: "Internal server error." });
  }
};

const GetTrackingByAwb = async (req, res) => {
  // console.log("hiei")
  try {
    const { awb } = req.params;
    // console.log("hii")
    const order = await Order.findOne({ awb_number: awb });

    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    // console.log("Order details:", order);
    res.status(200).json(order);
  } catch (error) {
    console.error("Error fetching tracking details:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};

const GetTrackingByAwbs = async (req, res) => {
  try {
    const { awbs } = req.body; // Expect array of AWB numbers
    // console.log("body", awbs);
    if (!Array.isArray(awbs) || awbs.length === 0) {
      return res
        .status(400)
        .json({ message: "Please provide an array of AWB numbers" });
    }

    // Fetch all matching orders for the array of AWB numbers
    const orders = await Order.find({ awb_number: { $in: awbs } });

    // Return only found orders, skipping missing AWBs
    res.status(200).json(orders);
  } catch (error) {
    console.error("Error fetching tracking details:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};

module.exports = {
  newOrder,
  getOrders,
  getOrdersByNdrStatus,
  updatedStatusOrders,
  getOrdersById,
  getpickupAddress,
  getreceiverAddress,
  newPickupAddress,
  newReciveAddress,
  ShipeNowOrder,
  getPinCodeDetails,
  cancelOrdersAtNotShipped,
  cancelOrdersAtBooked,
  // tracking,
  updateOrder,
  passbook,
  getUser,
  updatePackageDetails,
  GetTrackingByAwb,
  GetTrackingByAwbs,
  updatePickupAddress,
  setPrimaryPickupAddress,
  deletePickupAddress,
  getShippingOrders,
};
