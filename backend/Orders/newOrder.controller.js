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
const path = require("path");
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
const {
  cancelShipmentEkart,
} = require("../AllCouriers/Ekart/Couriers/couriers.controller");
const {
  cancelOrderBoxdLogistics,
} = require("../AllCouriers/BoxdLogistics/Courier/couriers.controller");
const {
  cancelProshipOrder,
  trackProshipOrder,
} = require("../AllCouriers/Proship/Courier/couriers.controller");
const {
  removeFromPickupManifest,
} = require("./scheduledPickup.controller");
// Create a shipment
const newOrder = async (req, res) => {
  try {
    const {
      pickupAddress,
      receiverAddress,
      productDetails,
      packageDetails,
      paymentDetails,
      otherDetails,
      orderType,
      B2BPackageDetails,
      // commodityId,
    } = req.body;
    // console.log(req.body);

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
    const User = await user.findById(req.user._id);
    if (User.kycDone !== true) {
      return res
        .status(400)
        .json({ error: "Please complete KYC to create an order" });
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
      otherDetails,
      compositeOrderId,
      status: "new",
      channel: "custom",
      orderType,
      B2BPackageDetails,
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
    // console.log("re", req.body);

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
      mongoose.Types.ObjectId.isValid(id),
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
      },
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
    // console.log(req.body); // To log the incoming request body
    const userId =
      req.query.userId &&
        req.query.userId !== "undefined" &&
        req.query.userId.trim() !== ""
        ? req.query.userId.trim()
        : req.user?._id?.toString();

    // Create a new shipment instance, where pickupAddress is a sub-document
    const shipment = new pickAddress({
      userId: userId, // ✅ Prefer userId from query if provided
      pickupAddress: {
        contactName: req.body.contactName,
        email: req.body.email,
        phoneNumber: req.body.phoneNumber,
        address: req.body.address || "",
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
      pickupContactName,
      courierServiceName
    } = req.query;
    let userId = null;
    // console.log("req", req.query)
    if (id && id !== "undefined" && id !== "null") {
      userId = id;
    } else if (req.user?._id) {
      userId = req.user._id;
    } else if (req.employee?._id) {
      userId = req.employee._id;
    }

    if (!userId) {
      return res.status(400).json({ error: "User ID required" });
    }

    const userObjectId = new mongoose.Types.ObjectId(userId);



    const page = parseInt(req.query.page) || 1;
    const limitQuery = req.query.limit;
    const limit =
      limitQuery === "All" || !limitQuery ? null : parseInt(limitQuery);
    const skip = limit ? (page - 1) * limit : 0;

    const andConditions = [{ userId: userObjectId }];


    // Include B2C + orders without orderType
    andConditions.push({
      $or: [{ orderType: "B2C" }, { orderType: { $exists: false } }],
    });

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
    if (awbNumber?.trim()) {
      andConditions.push({ awb_number: awbNumber.trim() });
    }

    if (trackingId) {
      andConditions.push({ trackingId: { $regex: trackingId, $options: "i" } });
    }
    if (req.query.courierServiceName) {
      const couriers = req.query.courierServiceName.split(",").map((c) => c.trim());
      andConditions.push({ courierServiceName: { $in: couriers } });
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
    const filter = { $and: andConditions };
    if (pickupContactName && pickupContactName.length > 0) {
      const names = Array.isArray(pickupContactName)
        ? pickupContactName
        : pickupContactName.split(",");

      filter["pickupAddress.contactName"] = {
        $in: names.map((n) => n.trim()),
      };
    }



    const totalCount = await Order.countDocuments(filter);
    let sortOption = { updatedAt: -1 };
    if (
      filter.status &&
      filter.status.$in &&
      filter.status.$in.includes("new")
    ) {
      sortOption = { createdAt: -1 };
    } else if (filter.status === "new") {
      sortOption = { createdAt: -1 };
    }
    let query = Order.find(filter).sort(sortOption);
    if (limit) query = query.skip(skip).limit(limit);

    const orders = await query.lean();
    // console.log(orders)
    const totalPages = limit ? Math.ceil(totalCount / limit) : 1;

    const allCourierServices = await Order.aggregate([
      {
        $match: { userId: userObjectId }
      },
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
    const allPickupLocations = await pickAddress.find({
      userId: userObjectId,
    })
      // .select("pickupAddress isPrimary")
      .lean();

    const formattedPickupLocations = allPickupLocations.map(p => ({
      ...p.pickupAddress,
      // isPrimary: p.isPrimary
    }));


    // console.log("all pickup", allPickupLocations)
    res.json({
      orders,
      totalPages,
      totalCount,
      currentPage: page,
      pickupLocations: formattedPickupLocations,
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
      status: { $nin: ["new"] },
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
      const couriers = req.query.courierServiceName.split(",").map((c) => c.trim());
      andConditions.push({ courierServiceName: { $in: couriers } });
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
      const names = req.query.pickupContactName.split(",").map((n) => n.trim());
      andConditions.push({
        "pickupAddress.contactName": { $in: names },
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
    const { pickupContactName } = req.query;
    const { id } = req.query;
    let userId;
    if (id) {
      userId = id;
    } else {
      userId = req.user._id;
    }
    console.log("req", req.query)
    const page = parseInt(req.query.page) || 1;
    const limitQuery = req.query.limit;
    const limit =
      limitQuery === "All" || !limitQuery ? null : parseInt(limitQuery);
    const skip = limit ? (page - 1) * limit : 0;
    const status = req.query.status;
    const tab = req.query.tab;
    const andConditions = [{ userId }];
    // ⭐ Special logic for Action Required tab
    if (status === "Undelivered" && tab === "Action_Required") {
      andConditions.push({ ndrStatus: "Undelivered" });
      andConditions.push({ reattempt: true });
    } else if (status === "Undelivered" && tab === "") {
      andConditions.push({ ndrStatus: status });
      andConditions.push({ reattempt: false });
    }

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
      const couriers = Array.isArray(req.query.courierServiceName)
        ? req.query.courierServiceName
        : req.query.courierServiceName.split(",");

      andConditions.push({
        courierServiceName: {
          $in: couriers.map((c) => c.trim()),
        },
      });
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


    const filter = { $and: andConditions };

    if (pickupContactName) {
      const names = Array.isArray(pickupContactName)
        ? pickupContactName
        : pickupContactName.split(",");

      andConditions.push({
        "pickupAddress.contactName": {
          $in: names.map((n) => n.trim()),
        },
      });
    }


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
    // Fetch all unique pickup locations for the user (not filtered)
    const allPickupLocations = await pickAddress.find({
      userId,
    })
      // .select("pickupAddress isPrimary")
      .lean();

    const formattedPickupLocations = allPickupLocations.map(p => ({
      ...p.pickupAddress,
      // isPrimary: p.isPrimary
    }));

    res.json({
      orders,
      totalPages,
      totalCount,
      currentPage: page,
      pickupLocations: formattedPickupLocations,
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
    // console.log("orderId", orderId);
    const {
      pickupAddress,
      receiverAddress,
      paymentDetails,
      packageDetails,
      otherDetails,
    } = req.body;

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
        contactName: pickupAddress.contactName,
        phoneNumber: pickupAddress.phoneNumber,
        email: pickupAddress.email,
        address: pickupAddress.address,
        city: pickupAddress.city,
        state: pickupAddress.state,
        pinCode: pickupAddress.pinCode,
      };
      // Remove undefined fields to avoid overwriting with null
      Object.keys(updateFields.pickupAddress).forEach(key =>
        updateFields.pickupAddress[key] === undefined && delete updateFields.pickupAddress[key]
      );
    }

    // Update receiverAddress if provided
    if (receiverAddress) {
      updateFields.receiverAddress = {
        contactName: receiverAddress.contactName,
        phoneNumber: receiverAddress.phoneNumber,
        email: receiverAddress.email,
        address: receiverAddress.address,
        city: receiverAddress.city,
        state: receiverAddress.state,
        pinCode: receiverAddress.pinCode,
      };
      // Remove undefined fields to avoid overwriting with null
      Object.keys(updateFields.receiverAddress).forEach(key =>
        updateFields.receiverAddress[key] === undefined && delete updateFields.receiverAddress[key]
      );
    }

    // Ensure paymentDetails exist before updating
    if (paymentDetails) {
      updateFields.paymentDetails = {
        method: paymentDetails.method || existingOrder.paymentDetails?.method,
        amount: paymentDetails.amount || existingOrder.paymentDetails?.amount,
      };
    }

    // Ensure packageDetails exist before updating
    if (packageDetails) {
      updateFields.packageDetails = {
        deadWeight:
          packageDetails.deadWeight || existingOrder.packageDetails?.deadWeight,
        applicableWeight:
          packageDetails.applicableWeight ||
          existingOrder.packageDetails?.applicableWeight,
        volumetricWeight: {
          length:
            packageDetails.volumetricWeight?.length ||
            existingOrder.packageDetails?.volumetricWeight?.length,
          width:
            packageDetails.volumetricWeight?.width ||
            existingOrder.packageDetails?.volumetricWeight?.width,
          height:
            packageDetails.volumetricWeight?.height ||
            existingOrder.packageDetails?.volumetricWeight?.height,
        },
      };
    }

    // Ensure otherDetails exist before updating
    if (otherDetails) {
      updateFields.otherDetails = {
        gstin: otherDetails.gstin || existingOrder.otherDetails?.gstin,
      };
    }

    console.log("updateFields to be applied:", updateFields);

    // Update order in the database
    const updatedOrder = await Order.findByIdAndUpdate(
      orderId,
      { $set: updateFields },
      { new: true, runValidators: true },
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

const updateProductDetails = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { productDetails } = req.body;

    if (!mongoose.Types.ObjectId.isValid(orderId)) {
      return res.status(400).json({ message: "Invalid orderId format." });
    }

    if (!productDetails || !Array.isArray(productDetails)) {
      return res
        .status(400)
        .json({ message: "productDetails must be an array." });
    }

    const updatedOrder = await Order.findByIdAndUpdate(
      orderId,
      { $set: { productDetails: productDetails } },
      { new: true, runValidators: true },
    );

    if (!updatedOrder) {
      return res.status(404).json({ message: "Order not found." });
    }

    res.status(200).json({
      message: "Product details updated successfully.",
      order: updatedOrder,
    });
  } catch (error) {
    console.error("Error updating product details:", error);
    res.status(500).json({ message: "Internal server error." });
  }
};
const getOrdersById = async (req, res) => {
  const { id } = req.params;

  try {
    let order;

    // ✅ Case 1: If valid Mongo ObjectId → search by _id
    if (mongoose.Types.ObjectId.isValid(id)) {
      order = await Order.findById(id);
    }

    // ✅ Case 2: If not found OR not ObjectId → search by orderId
    if (!order) {
      order = await Order.findOne({ orderId: id });
    }

    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    return res.status(200).json(order);

  } catch (err) {
    console.error("Error fetching order:", err);
    return res.status(500).json({ message: "Server error" });
  }
};


const updatedStatusOrders = async (req, res) => {
  try {
    const { id } = req.body;

    if (!id) {
      return res.status(400).json({ error: "Order ID is required" });
    }

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid order ID format" });
    }

    // Find the order first
    const order = await Order.findById(id);

    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    // Check current status
    if (order.status !== "Cancelled") {
      return res.status(400).json({
        success: false,
        message:
          "Order is not ready to be cloned. Current status: " + order.status,
      });
    }

    // Update status to "new"
    order.status = "new";
    await order.save();

    res.status(200).json({
      success: true,
      message: "Order clone successfully.",
      order,
    });
  } catch (error) {
    console.error("Error updating order status:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
};

const bulkCloneOrders = async (req, res) => {
  try {
    const { ids } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: "No order IDs provided" });
    }

    const validIds = ids.filter((id) => mongoose.Types.ObjectId.isValid(id));

    if (validIds.length === 0) {
      return res.status(400).json({ error: "No valid order IDs provided" });
    }

    // Update only orders that are currently "Cancelled"
    const result = await Order.updateMany(
      { _id: { $in: validIds }, status: "Cancelled" },
      { $set: { status: "new" } },
    );

    // If no orders were updated
    if (result.matchedCount === 0) {
      return res.status(404).json({
        success: false,
        message: "No cancelled orders found to update.",
      });
    }

    res.status(200).json({
      success: true,
      message: `${result.modifiedCount} order(s) clone successfully.`,
    });
  } catch (error) {
    console.error("Error updating orders:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
};

const getpickupAddress = async (req, res) => {
  try {
    // console.log("req.query.userId:", req.query.userId);
    // console.log("req.user._id:", req.user?._id);

    // ✅ Proper fallback handling (covers undefined, null, empty, and string "undefined")
    const userId =
      req.query.userId &&
        req.query.userId !== "undefined" &&
        req.query.userId !== "null" &&
        req.query.userId.trim() !== ""
        ? req.query.userId.trim()
        : req.user?._id?.toString();

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "User ID is missing or invalid",
      });
    }

    // console.log("✅ Final userId used:", userId);

    const pickupAddresses = await pickAddress.find({ userId });

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

const searchReceiver = async (req, res) => {
  try {
    const { query, userId: id } = req.query;

    let userId =
      id && id !== "undefined" && id.trim() !== ""
        ? id
        : req.user?._id || req.employee?._id;

    // console.log("Search Receiver Request:", { query, id, userId });

    if (!query || query.length < 2) {
      return res.status(200).json({ success: true, receivers: [] });
    }

    if (!userId) {
      return res.status(400).json({ success: false, message: "User ID required" });
    }

    // Validate ObjectId
    let userObjectId;
    try {
      userObjectId = new mongoose.Types.ObjectId(userId);
    } catch (e) {
      return res.status(400).json({ success: false, message: "Invalid User ID format" });
    }

    // ✅ Fetch User to check admin status
    const userData = await user.findById(userObjectId).select("isAdmin adminTab");

    if (!userData) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const isAdmin =
      userData?.isAdmin === true && userData?.adminTab === true;

    // ✅ Build Match Condition Dynamically
    const matchStage = isAdmin
      ? {} // Admin → no user filter
      : { userId: userObjectId }; // Normal user → filter by userId

    const receivers = await Order.aggregate([
      { $match: matchStage },

      {
        $match: {
          $or: [
            { "receiverAddress.contactName": { $regex: query, $options: "i" } },
            { "receiverAddress.email": { $regex: query, $options: "i" } },
            { "receiverAddress.phoneNumber": { $regex: query, $options: "i" } },
          ],
        },
      },

      {
        $group: {
          _id: {
            contactName: "$receiverAddress.contactName",
            email: "$receiverAddress.email",
            phoneNumber: "$receiverAddress.phoneNumber",
          },
        },
      },

      {
        $project: {
          _id: 0,
          contactName: "$_id.contactName",
          email: "$_id.email",
          phoneNumber: "$_id.phoneNumber",
        },
      },

      { $limit: 10 },
    ]);

    res.status(200).json({ success: true, receivers });

  } catch (error) {
    console.error("Error searching receiver:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
};


const ShipeNowOrder = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    // console.log("order", order);
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    const plan = await Plan.findOne({ userId: order.userId });
    // console.log("plan", plan);
    const users = await user.findOne({ _id: order.userId });
    const userWallet = await Wallet.findOne({ _id: users.Wallet });

    // ✅ fetch EDDMap
    const EDDRates = await EDDMap.find();

    // ✅ fetch enabled + active courier services
    const services = await CourierService.find({ status: "Enable" });
    const enabledServices = [];
    const normalize = (str) => str?.toLowerCase().replace(/\s+/g, "").trim();
    for await (const srvc of services) {
      const provider = await Courier.findOne({
        courierProvider: srvc.provider,
      });
      // console.log("service",srvc)
      // ✅ check both provider & courier service statuses
      if (provider?.status === "Enable" && srvc.status === "Enable") {
        // console.log("plan", plan);
        const planRateCard = plan.rateCard.filter(
          (card) => {
            const sameProvider = normalize(card.courierProviderName) === normalize(srvc.provider);
            const sameName = normalize(card.courierServiceName) === normalize(srvc.name);
            const isBoxdSpecial = normalize(srvc.provider) === "boxdlogistics";

            return sameProvider && (sameName || isBoxdSpecial) && card.status === "Active";
          }
        );
        // console.log("planRateCard",planRateCard)
        if (planRateCard && planRateCard.length > 0) {
          enabledServices.push(srvc);
        }
      }
    }

    const availableServicesResults = await Promise.all(
      enabledServices.map(async (item) => {
        let result = await checkServiceabilityAll(
          item,
          order._id,
          order.pickupAddress.pinCode,
        );
        // console.log("result",result)
        if (result && result.success) {
          if (item.provider?.toLowerCase() === "boxdlogistics" && Array.isArray(result.courier_ids)) {
            // Determine which courierId this specific service name maps to
            const sName = item.name?.toLowerCase() || "";
            const requiredCid = sName.includes("surface") ? 4 : sName.includes("air") ? 6 : null;
            if (requiredCid !== null && result.courier_ids.includes(requiredCid)) {
              return [{ item, courierId: requiredCid, virtualName: normalize(item.name) }];
            }
            return [];
          }
          return [{ item }];
        }
        return [];
      }),
    );
    // console.log("available", availableServicesResults);

    const filteredServices = Array.from(
      new Map(
        availableServicesResults
          .flat()
          .map((s) => [
            // Use normalized service name so each rate card variant (0.5KG, 1KG) is a unique key
            `${s.item.provider}-${normalize(s.virtualName || s.item.name)}`,
            s,
          ])
      ).values()
    );
    // console.log("filterservice",filteredServices)
    // ✅ calculate zone
    const zone = await getZone(
      order.pickupAddress.pinCode,
      order.receiverAddress.pinCode,
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
      userID: order.userId,
      filteredServices,
      rateCardType: plan.planName,
    };

    let rates = await calculateRateForService(payload);
    // console.log("rate", rates);
    // console.log("filtere", filteredServices);

    // ✅ Build updatedRates only for serviceable couriers
    const updatedRates = filteredServices
      .map((service) => {
        const matchedRate = rates.find((rate) => {
          const rateName = normalize(rate.courierServiceName);
          const serviceName = normalize(
            service.virtualName || service.item.name
          );
          // Exact match for all couriers including BoxdLogistics variants
          return rateName === serviceName;
        });

        if (!matchedRate) return null;

        const matchedEDD = EDDRates.find(
          (edd) => normalize(edd.serviceName) === normalize(service.item.name),
        );

        let estimatedDeliveryDate = null;
        if (matchedEDD && matchedEDD.zoneRates) {
          const zoneKey = zone.zone;
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
          courier: service.courierId || service.item?.courier,
          serviceName: service.virtualName || service.item.name,
          estimatedDeliveryDate,
        };
      })
      .filter(Boolean);
    // console.log("update", updatedRates);
    // ✅ SORTING based on plan.priorityType
    let sortedRates = [...updatedRates];

    let priorityType = plan?.priorityType?.toLowerCase();
    if (!["cheapest", "fastest", "custom"].includes(priorityType)) {
      priorityType = "cheapest";
    }
    if (priorityType === "cheapest") {
      // Sort by lowest finalCharges
      sortedRates.sort((a, b) => {
        const chargeA = parseFloat(
          a.forward?.finalCharges || a.forward?.charges || 0,
        );
        const chargeB = parseFloat(
          b.forward?.finalCharges || b.forward?.charges || 0,
        );
        return chargeA - chargeB;
      });
    } else if (priorityType === "fastest") {
      sortedRates.sort(
        (a, b) =>
          new Date(a.estimatedDeliveryDate) - new Date(b.estimatedDeliveryDate),
      );
    } else if (priorityType === "custom" && Array.isArray(plan.rateCard)) {
      const customOrder = plan.rateCard.map((r) =>
        r?.courierServiceName?.toLowerCase(),
      );
      sortedRates.sort((a, b) => {
        const indexA = customOrder.indexOf(a.courierServiceName?.toLowerCase());
        const indexB = customOrder.indexOf(b.courierServiceName?.toLowerCase());
        return indexA - indexB;
      });
    }

    // console.log("sortedRates", sortedRates);

    res.status(201).json({
      success: true,
      order,
      updatedRates: sortedRates,
    });
  } catch (error) {
    console.error("Error in ShipeNowOrder:", error);
    res.status(500).json({ error: "Server error" });
  }
};

const pincodeData = [];
fs.createReadStream(path.join(__dirname, "../data/pincodes.csv"))
  .pipe(csv({ separator: "\t" })) // <-- Important fix
  .on("data", (row) => {
    if (row.pincode && row.city && row.state) {
      pincodeData.push({
        pincode: row.pincode.trim(),
        city: row.city.trim(),
        state: row.state.trim(),
      });
    } else {
      console.log("Invalid CSV row:", row);
    }
  })
  .on("end", () => {
    console.log("✅ CSV file successfully loaded. Total:", pincodeData.length);
  })
  .on("error", (err) => {
    console.error("❌ Error reading CSV file:", err);
  });

// ✅ API Controller
const getPinCodeDetails = async (req, res) => {
  try {
    const { pincode } = req.params;
    const foundEntry = pincodeData.find(
      (entry) => entry.pincode === pincode.trim(),
    );

    if (foundEntry) {
      res.json({
        city: foundEntry.city,
        state: foundEntry.state,
      });
    } else {
      res.status(404).json({ error: "Pincode not found" });
    }
  } catch (error) {
    console.error("❌ Error fetching pincode:", error);
    res.status(500).json({ error: "Internal Server Error" });
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
    } else if (currentOrder.provider === "Ekart") {
      const result = await cancelShipmentEkart(currentOrder.awb_number);
      if (result.error) {
        return res.status(400).send({ error: result.error });
      }
    } else if (currentOrder.partner === "BoxdLogistics") {
      const result = await cancelOrderBoxdLogistics(currentOrder.awb_number, currentOrder.orderId);
      if (result.error) {
        return res.status(400).send({ error: result.error });
      }
    } else if (currentOrder.partner === "Proship") {
      const result = await cancelProshipOrder(currentOrder.awb_number);
      if (result.error) {
        return res.status(400).send({ error: result.error });
      }
    }
    else {
      return {
        error: "Unsupported courier provider",
        orderId: currentOrder._id,
      };
    }

    // Remove from pickup manifest if exists
    try {
      await removeFromPickupManifest(currentOrder);
    } catch (err) {
      console.error("[Pickup] Failed to remove order from manifest during cancellation:", err.message);
    }

    // currentOrder.status = "Not-Shipped";
    // currentOrder.cancelledAtStage = "Booked";
    currentOrder.status = "Cancelled";
    currentOrder.tracking.push({
      status: "Cancelled",
      StatusLocation: "",
      StatusDateTime: new Date(Date.now() + 5.5 * 60 * 60 * 1000),
      Instructions: "Order cancelled successfully",
    });

    let balanceTobeAdded =
      allOrders.totalFreightCharges == "N/A"
        ? 0
        : parseFloat(allOrders.totalFreightCharges);
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // ✅ Guard: Check if this AWB was already refunded (credit exists)
      const alreadyRefunded = currentWallet.transactions.some(
        (t) =>
          t.awb_number === currentOrder.awb_number &&
          t.category === "credit" &&
          t.description === "Freight Charges Received"
      );

      if (balanceTobeAdded > 0 && !alreadyRefunded) {
        const updatedWallet = await Wallet.findOneAndUpdate(
          { _id: currentWallet._id },
          { $inc: { balance: balanceTobeAdded } },
          { new: true, session },
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
          { session },
        );
      } else if (balanceTobeAdded > 0 && alreadyRefunded) {
        console.log(`[Cancel] Skipping wallet refund for AWB ${currentOrder.awb_number} — already refunded.`);
      }

      await currentOrder.save({ session });
      await session.commitTransaction();
      await currentOrder.save({ session });
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
      description,
      awbNumber,
      orderId,
      page = 1,
      limit = 20,
    } = req.query;

    if (!userId) {
      return res.status(400).json({ message: "User ID is required" });
    }

    const currentUser = await user.findById(userId).select("_id Wallet");
    if (!currentUser || !currentUser.Wallet) {
      return res.status(404).json({ message: "Wallet not found" });
    }

    const parsedLimit = limit === "all" ? 0 : Number(limit);
    const skip = (Number(page) - 1) * parsedLimit;

    // Build filters for transactions
    const matchFilters = {};
    if (fromDate && toDate) {
      matchFilters["wallet.transactions.date"] = {
        $gte: new Date(new Date(fromDate).setHours(0, 0, 0, 0)),
        $lte: new Date(new Date(toDate).setHours(23, 59, 59, 999)),
      };
    }
    if (category) matchFilters["wallet.transactions.category"] = category;
    if (description) matchFilters["wallet.transactions.description"] = description;
    if (awbNumber) matchFilters["wallet.transactions.awb_number"] = awbNumber;
    if (orderId) matchFilters["wallet.transactions.channelOrderId"] = orderId;

    const pipeline = [
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
      { $match: matchFilters },
      {
        $facet: {
          metadata: [{ $count: "total" }],
          data: [
            { $sort: { "wallet.transactions.date": -1 } },
            ...(parsedLimit > 0 ? [{ $skip: skip }, { $limit: parsedLimit }] : []),
            {
              $lookup: {
                from: "neworders",
                let: { txnAwb: "$wallet.transactions.awb_number" },
                pipeline: [
                  {
                    $match: {
                      $expr: {
                        $and: [
                          { $ne: ["$$txnAwb", null] },
                          { $eq: [{ $toString: "$awb_number" }, { $toString: "$$txnAwb" }] }
                        ]
                      }
                    }
                  },
                  { $limit: 1 },
                  { $project: { courierServiceName: 1, priceBreakup: 1, rateBreakup: 1, orderType: 1, _id: 0 } }
                ],
                as: "orderInfo"
              }
            },
            {
              $project: {
                _id: { $toString: "$wallet.transactions._id" },
                id: { $toString: "$wallet.transactions._id" },
                category: "$wallet.transactions.category",
                amount: "$wallet.transactions.amount",
                balanceAfterTransaction: "$wallet.transactions.balanceAfterTransaction",
                date: "$wallet.transactions.date",
                awb_number: "$wallet.transactions.awb_number",
                orderId: "$wallet.transactions.channelOrderId",
                description: "$wallet.transactions.description",
                courierServiceName: { $arrayElemAt: ["$orderInfo.courierServiceName", 0] },
                priceBreakup: { $ifNull: ["$wallet.transactions.priceBreakup", { $arrayElemAt: ["$orderInfo.priceBreakup", 0] }] },
                rateBreakup: { $arrayElemAt: ["$orderInfo.rateBreakup", 0] },
                orderType: { $arrayElemAt: ["$orderInfo.orderType", 0] }
              }
            }
          ]
        }
      }
    ];

    const result = await user.aggregate(pipeline);
    const totalCount = result[0]?.metadata[0]?.total || 0;
    const totalPages = parsedLimit === 0 ? 1 : Math.ceil(totalCount / parsedLimit);

    return res.status(200).json({
      message: "Passbook fetched successfully",
      results: result[0]?.data || [],
      totalCount,
      page: totalPages,
      currentPage: Number(page),
      limit: parsedLimit === 0 ? "All" : parsedLimit,
    });
  } catch (error) {
    console.error("Error fetching passbook:", error);
    return res.status(500).json({ message: "Internal server error", error: error.message });
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

const bulkCancelOrder = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const { selectedOrders } = req.body;

    if (!Array.isArray(selectedOrders) || selectedOrders.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No orders selected for cancellation.",
      });
    }

    // Fetch all orders
    const orders = await Order.find({ _id: { $in: selectedOrders } });
    if (!orders.length)
      return res
        .status(404)
        .json({ success: false, message: "No matching orders found." });

    let successCount = 0;
    let failedCount = 0;
    const results = [];

    // Loop through each order separately
    for (const currentOrder of orders) {
      const orderSession = await mongoose.startSession();
      orderSession.startTransaction();

      try {
        if (
          !["Booked", "Not Picked", "Ready To Ship"].includes(
            currentOrder.status,
          )
        ) {
          failedCount++;
          results.push({
            orderId: currentOrder._id,
            status: "skipped",
            reason: `Order status is '${currentOrder.status}', not cancellable.`,
          });
          await orderSession.abortTransaction();
          orderSession.endSession();
          continue;
        }

        // ✅ Take userId from order itself
        const userId = currentOrder.userId;

        // --- Fetch user and wallet based on order’s userId ---
        const userDoc = await user.findById(userId);
        if (!userDoc) {
          failedCount++;
          results.push({
            orderId: currentOrder._id,
            status: "failed",
            reason: "User not found for this order.",
          });
          await orderSession.abortTransaction();
          orderSession.endSession();
          continue;
        }

        const walletId = userDoc.Wallet;
        if (!walletId) {
          failedCount++;
          results.push({
            orderId: currentOrder._id,
            status: "failed",
            reason: "User wallet not found.",
          });
          await orderSession.abortTransaction();
          orderSession.endSession();
          continue;
        }

        const walletDoc = await Wallet.findById(walletId);
        if (!walletDoc) {
          failedCount++;
          results.push({
            orderId: currentOrder._id,
            status: "failed",
            reason: "Wallet document not found.",
          });
          await orderSession.abortTransaction();
          orderSession.endSession();
          continue;
        }

        // ✅ Determine provider
        const provider =
          currentOrder.partner === "ZipyPost" &&
            currentOrder.provider === "Bluedart"
            ? "ZipyPost"
            : currentOrder.partner === "BoxdLogistics"
              ? "BoxdLogistics"
              : currentOrder.partner === "Proship"
                ? "Proship"
                : currentOrder.provider;

        // --- Cancel order by provider ---
        let cancelResponse;
        switch (provider) {
          case "Delhivery":
            cancelResponse = await cancelOrderDelhivery(
              currentOrder.awb_number,
            );
            break;
          case "Amazon Shipping":
            cancelResponse = await cancelShipment(currentOrder.shipment_id);
            break;
          case "ZipyPost":
            cancelResponse = await cancelOrderZipypost(currentOrder.awb_number);
            break;
          case "Shree Maruti":
            cancelResponse = await cancelOrderShreeMaruti(currentOrder.orderId);
            break;
          case "Dtdc":
            cancelResponse = await cancelOrderDTDC(currentOrder.awb_number);
            break;
          case "Ekart":
            cancelResponse = await cancelShipmentEkart(currentOrder.awb_number);
            break;
          case "BoxdLogistics":
            cancelResponse = await cancelOrderBoxdLogistics(currentOrder.awb_number, currentOrder.orderId);
            break;
          case "Proship":
            cancelResponse = await cancelProshipOrder(currentOrder.awb_number);
            break;
          default:
            failedCount++;
            results.push({
              orderId: currentOrder._id,
              status: "failed",
              reason: `Unknown provider: ${currentOrder.provider}`,
            });
            await orderSession.abortTransaction();
            orderSession.endSession();
            continue;
        }

        // --- Handle API failure ---
        if (cancelResponse?.success === false) {
          failedCount++;
          results.push({
            orderId: currentOrder._id,
            status: "failed",
            reason:
              cancelResponse?.message ||
              cancelResponse?.error ||
              "Provider API returned failure",
          });
          await orderSession.abortTransaction();
          orderSession.endSession();
          continue;
        }

        // Remove from pickup manifest if exists
        try {
          await removeFromPickupManifest(currentOrder);
        } catch (err) {
          console.error("[Pickup] Failed to remove order from manifest during bulk cancellation:", err.message);
        }

        // --- Refund wallet balance safely ---
        const balanceToAdd =
          currentOrder.totalFreightCharges === "N/A"
            ? 0
            : parseFloat(currentOrder.totalFreightCharges) || 0;

        if (balanceToAdd > 0) {
          // ✅ Guard: Check if this AWB was already refunded (credit exists)
          const alreadyRefunded = walletDoc.transactions.some(
            (t) =>
              t.awb_number === currentOrder.awb_number &&
              t.category === "credit" &&
              t.description === "Freight Charges Received"
          );

          if (!alreadyRefunded) {
            const updatedWallet = await Wallet.findOneAndUpdate(
              { _id: walletId },
              { $inc: { balance: balanceToAdd } },
              { new: true, session: orderSession },
            );

            await Wallet.updateOne(
              { _id: walletId },
              {
                $push: {
                  transactions: {
                    channelOrderId: currentOrder.orderId || null,
                    category: "credit",
                    amount: balanceToAdd,
                    balanceAfterTransaction: updatedWallet.balance,
                    date: new Date(),
                    awb_number: currentOrder.awb_number || "",
                    description: "Freight Charges Received",
                  },
                },
              },
              { session: orderSession },
            );
          } else {
            console.log(`[BulkCancel] Skipping wallet refund for AWB ${currentOrder.awb_number} — already refunded.`);
          }
        }

        // --- Update order details ---
        currentOrder.status = "Cancelled";

        currentOrder.tracking.push({
          status: "Cancelled",
          StatusLocation: "",
          StatusDateTime: new Date(Date.now() + 5.5 * 60 * 60 * 1000),
          Instructions: "Order cancelled successfully",
        });

        await currentOrder.save({ session: orderSession });
        await orderSession.commitTransaction();
        orderSession.endSession();

        successCount++;
        results.push({
          orderId: currentOrder._id,
          status: "success",
          provider: currentOrder.provider,
        });
      } catch (err) {
        await orderSession.abortTransaction();
        orderSession.endSession();
        failedCount++;
        results.push({
          orderId: currentOrder._id,
          status: "failed",
          reason: err.message,
        });
      }
    }

    session.endSession();

    return res.status(200).json({
      success: true,
      totalOrders: orders.length,
      successCount,
      failedCount,
      message: `✅ ${successCount} order(s) cancelled successfully, ❌ ${failedCount} order(s) failed.`,
      details: results,
    });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.error("Bulk Cancel Error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error during bulk cancellation.",
      error: error.message,
    });
  }
};

const checkBulkPickup = async (req, res) => {
  try {
    const { orderIds } = req.query; // array of order IDs

    if (!orderIds || !Array.isArray(orderIds) || orderIds.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "No order IDs provided" });
    }

    // Fetch orders with their pickupAddress
    const orders = await Order.find({ _id: { $in: orderIds } }).select(
      "pickupAddress userId",
    );

    if (orders.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Orders not found" });
    }

    // Only 1 order selected → popup required
    if (orders.length === 1) {
      return res.json({
        success: true,
        showPopup: true,
        orders,
      });
    }

    // Check if all pickup addresses are the same
    const pickupAddresses = orders.map((o) =>
      JSON.stringify(o.pickupAddress || {}),
    );
    const allSame =
      pickupAddresses.every((addr) => addr === pickupAddresses[0]) &&
      pickupAddresses[0] !== "{}";

    res.json({
      success: true,
      showPopup: !allSame, // true if addresses differ → show popup
      allSame,
      orders,
      defaultPickup: allSame ? orders[0].pickupAddress : null,
    });
  } catch (error) {
    console.error("Error in checkBulkPickup:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

const checkBulkUser = async (req, res) => {
  try {
    const { orderIds } = req.query;

    // ✅ Check if orderId param is valid
    if (!orderIds || !Array.isArray(orderIds) || orderIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid or missing order IDs",
      });
    }

    // ✅ Fetch all orders by IDs
    const orders = await Order.find({ _id: { $in: orderIds } }).select(
      "userId",
    );

    if (!orders || orders.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No orders found for given IDs",
      });
    }

    // ✅ Extract all unique userIds
    const uniqueUsers = [...new Set(orders.map((o) => o.userId.toString()))];

    if (uniqueUsers.length === 1) {
      // ✅ All belong to same user
      return res.status(200).json({
        success: true,
        userId: uniqueUsers[0],
      });
    } else {
      // ❌ Different users found
      return res.status(400).json({
        success: false,
        message: "Selected orders belong to multiple users",
      });
    }
  } catch (error) {
    console.error("Error checking bulk user:", error);
    return res.status(500).json({
      success: false,
      message: "Server error while checking orders",
      error: error.message,
    });
  }
};

const checkCourier = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
};

// Master Search Controller - Search across multiple fields
const masterSearch = async (req, res) => {
  try {
    const { query } = req.query;

    const userId = req.user?._id || req.employee?._id;

    if (!query || query.trim().length < 2) {
      return res.json({ orders: [] });
    }

    // ✅ Fetch user properly
    const userData = await user.findById(userId).select("isAdmin adminTab");

    const isAdmin =
      userData?.isAdmin === true && userData?.adminTab === true;

    const searchTerm = query.trim();

    const searchConditions = [];

    // If numeric → match orderId
    if (!isNaN(searchTerm)) {
      searchConditions.push({ orderId: parseInt(searchTerm) });
    }

    // Text search
    searchConditions.push(
      { awb_number: { $regex: searchTerm, $options: "i" } },
      { "pickupAddress.contactName": { $regex: searchTerm, $options: "i" } },
      { "pickupAddress.email": { $regex: searchTerm, $options: "i" } },
      { "pickupAddress.phoneNumber": { $regex: searchTerm, $options: "i" } },
      { "receiverAddress.contactName": { $regex: searchTerm, $options: "i" } },
      { "receiverAddress.email": { $regex: searchTerm, $options: "i" } },
      { "receiverAddress.phoneNumber": { $regex: searchTerm, $options: "i" } },
      { courierServiceName: { $regex: searchTerm, $options: "i" } },
      { provider: { $regex: searchTerm, $options: "i" } }
    );

    // ✅ Build filter dynamically
    let filter;

    if (isAdmin) {
      // Admin → no userId restriction
      filter = { $or: searchConditions };
    } else {
      // Normal user → restrict by userId
      filter = {
        $and: [
          { userId },
          { $or: searchConditions }
        ]
      };
    }

    const orders = await Order.find(filter)
      .select("orderId awb_number status courierServiceName provider paymentDetails createdAt")
      .sort({ updatedAt: -1 })
      .limit(10)
      .lean();

    res.json({ orders });

  } catch (error) {
    console.error("Master search error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};


module.exports = {
  newOrder,
  getOrders,
  getOrdersByNdrStatus,
  updatedStatusOrders,
  bulkCloneOrders,
  getOrdersById,
  getpickupAddress,
  getreceiverAddress,
  searchReceiver,
  newPickupAddress,
  newReciveAddress,
  ShipeNowOrder,
  getPinCodeDetails,
  cancelOrdersAtNotShipped,
  cancelOrdersAtBooked,
  // tracking,
  updateOrder,
  updateProductDetails,
  passbook,
  getUser,
  updatePackageDetails,
  GetTrackingByAwb,
  GetTrackingByAwbs,
  updatePickupAddress,
  setPrimaryPickupAddress,
  deletePickupAddress,
  getShippingOrders,
  bulkCancelOrder,
  checkBulkPickup,
  checkBulkUser,
  checkCourier,
  masterSearch,
};
