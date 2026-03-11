const mongoose = require("mongoose");
const Order = require("../models/newOrder.model");
const PickupManifest = require("../models/pickupManifest.model");
const PickupManifestCounter = require("../models/pickupManifestCounter.model");
const AllocateRole = require("../models/allocateRoleSchema");

/* ================================================================
   CORE UTILITY — called automatically after any shipment is created
   Groups by: date + pickupAddress + provider (courier service)
   ================================================================ */
const assignPickupManifest = async (order, pickupDate = null) => {
  try {
    // Default to today (IST midnight)
    const dateToUse = pickupDate ? new Date(pickupDate) : new Date();
    dateToUse.setHours(0, 0, 0, 0);

    // ── Look for existing manifest with same grouping key ──────────────────
    const manifest = await PickupManifest.findOne({
      userId: order.userId,
      pickupDate: dateToUse,
      orderType: order.orderType || "B2C",
      provider: order.provider,                        // same courier
      "pickupAddress.address": order.pickupAddress?.address,
      "pickupAddress.contactName": order.pickupAddress?.contactName,
      "pickupAddress.pinCode": order.pickupAddress?.pinCode,
    });

    if (!manifest) {
      // ── Create new manifest and generate a fresh pickupId ─────────────────
      const dateStr = dateToUse.toISOString().split("T")[0];
      const pickupId = await generatePickupId(dateStr, order.orderType === "B2B");

      const newManifest = await PickupManifest.create({
        userId: order.userId,
        pickupId,
        pickupDate: dateToUse,
        status: "Pickup_Scheduled",
        orderIds: [order._id],
        awb_numbers: order.awb_number ? [order.awb_number] : [],
        provider: order.provider,
        providers: [order.provider],
        courierServiceNames: order.courierServiceName ? [order.courierServiceName] : [],
        orderType: order.orderType || "B2C",
        pickupAddress: order.pickupAddress,
      });

      // Save pickupId back to the order
      await Order.findByIdAndUpdate(order._id, { pickupId: newManifest.pickupId });
      console.log(`[Pickup] Created manifest ${newManifest.pickupId} for order ${order._id}`);
      return newManifest.pickupId;

    } else {
      // ── Append to existing manifest (no duplicates) ────────────────────────
      if (!manifest.orderIds.some((id) => id.equals(order._id))) {
        manifest.orderIds.push(order._id);
      }
      if (order.awb_number && !manifest.awb_numbers.includes(order.awb_number)) {
        manifest.awb_numbers.push(order.awb_number);
      }
      if (order.courierServiceName && !manifest.courierServiceNames.includes(order.courierServiceName)) {
        manifest.courierServiceNames.push(order.courierServiceName);
      }

      manifest.status = "Pickup_Scheduled";
      await manifest.save();

      // Save pickupId back to the order
      await Order.findByIdAndUpdate(order._id, { pickupId: manifest.pickupId });
      console.log(`[Pickup] Appended order ${order._id} to manifest ${manifest.pickupId}`);
      return manifest.pickupId;
    }
  } catch (err) {
    console.error("[Pickup] assignPickupManifest error:", err.message);
    return null;
  }
};

/* ================================================================
   HTTP CONTROLLER — kept for manual scheduling from admin panel
   ================================================================ */
const schedulePickup = async (req, res) => {
  try {
    const { orderIds, pickupDate } = req.body;

    if (!orderIds || !Array.isArray(orderIds) || orderIds.length === 0 || !pickupDate) {
      return res
        .status(400)
        .json({ message: "orderIds (array) and pickupDate required" });
    }

    let successCount = 0;
    let failedOrders = [];

    for (const orderId of orderIds) {
      try {
        const order = await Order.findById(orderId);
        if (!order) {
          failedOrders.push({ orderId, reason: "Order not found" });
          continue;
        }

        if (!["Booked", "Ready To Ship"].includes(order.status)) {
          failedOrders.push({ orderId, reason: `Order is in ${order.status} status` });
          continue;
        }

        // Call provider pickup API (mostly returns success:true as placeholder)
        const pickupResponse = await callPickupProvider(order.provider, { order, pickupDate });

        if (!pickupResponse?.success) {
          failedOrders.push({ orderId, reason: pickupResponse?.message || "Provider pickup scheduling failed" });
          continue;
        }

        // Re-assign/update manifest with the specified pickup date
        await assignPickupManifest(order, pickupDate);

        // Update order pickup date
        order.pickupDate = new Date(pickupDate);
        order.pickupDate.setHours(0, 0, 0, 0);
        await order.save();

        successCount++;
      } catch (err) {
        console.error(`Error scheduling pickup for order ${orderId}:`, err);
        failedOrders.push({ orderId, reason: err.message });
      }
    }

    return res.status(200).json({
      success: true,
      message: `${successCount} pickups scheduled successfully`,
      failedCount: failedOrders.length,
      failedOrders,
    });
  } catch (error) {
    console.error("schedulePickup error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};


const getPickupManifests = async (req, res) => {
  try {
    const { page = 1, limit = 20, startDate, endDate, searchQuery, pickupContactName, courierServiceName, orderType } = req.query;

    const userId = req.user?._id;

    let query = {};
    if (userId) query.userId = userId;

    if (startDate || endDate) {
      query.pickupDate = {};
      if (startDate) query.pickupDate.$gte = new Date(new Date(startDate).setHours(0, 0, 0, 0));
      if (endDate) query.pickupDate.$lte = new Date(new Date(endDate).setHours(23, 59, 59, 999));
    }

    if (orderType) {
      query.orderType = orderType;
    }

    if (searchQuery) {
      query.$or = [
        { pickupId: { $regex: searchQuery, $options: "i" } },
        { awb_numbers: { $in: [new RegExp(searchQuery, "i")] } },
      ];
    }

    if (pickupContactName || courierServiceName) {
      let orderQuery = {};
      if (userId) orderQuery.userId = userId;

      if (pickupContactName) {
        const names = Array.isArray(pickupContactName)
          ? pickupContactName
          : pickupContactName.includes(",")
            ? pickupContactName.split(",")
            : [pickupContactName];
        orderQuery["pickupAddress.contactName"] = { $in: names };
      }

      if (courierServiceName) {
        const couriers = Array.isArray(courierServiceName)
          ? courierServiceName
          : courierServiceName.includes(",")
            ? courierServiceName.split(",")
            : [courierServiceName];
        orderQuery["courierServiceName"] = { $in: couriers };
      }

      const matchingOrders = await Order.find(orderQuery).select("_id");
      const matchingOrderIds = matchingOrders.map((o) => o._id);

      if (matchingOrderIds.length > 0) {
        query.orderIds = { $in: matchingOrderIds };
      } else {
        // If filters are provided but no orders match, the manifest list should be empty
        query.orderIds = { $in: [new mongoose.Types.ObjectId()] };
      }
    }

    // To get filter options (locations/couriers), we need to check all manifests for this user
    let filterOptionsQuery = { userId };
    if (orderType) filterOptionsQuery.orderType = orderType;

    const allMatchingManifests = await PickupManifest.find(filterOptionsQuery)
      .populate({
        path: "orderIds",
        select: "pickupAddress courierServiceName",
      });

    const pickupLocations = [...new Set(allMatchingManifests.flatMap(m => m.orderIds.map(o => o.pickupAddress?.contactName)).filter(Boolean))];
    const courierServices = [...new Set(allMatchingManifests.flatMap(m => m.orderIds.map(o => o.courierServiceName)).filter(Boolean))];

    const manifests = await PickupManifest.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .populate("userId", "fullname email phoneNumber company userId")
      .populate({
        path: "orderIds",
        populate: { path: "userId", select: "fullname email phoneNumber company userId" }
      });

    const total = await PickupManifest.countDocuments(query);

    return res.status(200).json({
      success: true,
      manifests,
      totalPages: Math.ceil(total / limit),
      total,
      pickupLocations,
      courierServices
    });
  } catch (error) {
    console.error("getPickupManifests error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

const filterPickupManifestsForAdmin = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      startDate,
      endDate,
      searchQuery,
      pickupContactName,
      courierServiceName,
      orderType,
      userId,
    } = req.query;

    let query = {};

    // For Admin/Employee, allow filtering by userId
    if (userId) {
      query.userId = new mongoose.Types.ObjectId(userId);
    }

    // Handle Employee role allocations
    if (req.employee && req.employee.employeeId) {
      const allocations = await AllocateRole.find({
        employeeId: req.employee.employeeId,
      });

      const allocatedUserIds = allocations.map((a) => a.sellerMongoId.toString());

      if (allocatedUserIds.length === 0) {
        return res.json({
          success: true,
          manifests: [],
          totalPages: 0,
          total: 0,
        });
      }

      if (userId) {
        if (!allocatedUserIds.includes(userId.toString())) {
          return res.json({
            success: true,
            manifests: [],
            totalPages: 0,
            total: 0,
          });
        }
      } else {
        query.userId = {
          $in: allocatedUserIds.map((id) => new mongoose.Types.ObjectId(id)),
        };
      }
    }

    if (startDate || endDate) {
      query.pickupDate = {};
      if (startDate) query.pickupDate.$gte = new Date(new Date(startDate).setHours(0, 0, 0, 0));
      if (endDate) query.pickupDate.$lte = new Date(new Date(endDate).setHours(23, 59, 59, 999));
    }

    if (orderType) {
      query.orderType = orderType;
    }

    if (searchQuery) {
      const users = await User.find({
        $or: [
          { fullname: { $regex: searchQuery, $options: "i" } },
          { userId: { $regex: searchQuery, $options: "i" } },
          { email: { $regex: searchQuery, $options: "i" } },
        ],
      }).select("_id");
      const userIds = users.map((u) => u._id);

      query.$or = [
        { pickupId: { $regex: searchQuery, $options: "i" } },
        { awb_numbers: { $in: [new RegExp(searchQuery, "i")] } },
        { userId: { $in: userIds } },
      ];
    }

    if (pickupContactName || courierServiceName) {
      let orderQuery = {};
      if (query.userId) orderQuery.userId = query.userId;

      if (pickupContactName) {
        const names = Array.isArray(pickupContactName)
          ? pickupContactName
          : pickupContactName.includes(",")
            ? pickupContactName.split(",")
            : [pickupContactName];
        orderQuery["pickupAddress.contactName"] = { $in: names };
      }

      if (courierServiceName) {
        const couriers = Array.isArray(courierServiceName)
          ? courierServiceName
          : courierServiceName.includes(",")
            ? courierServiceName.split(",")
            : [courierServiceName];
        orderQuery["courierServiceName"] = { $in: couriers };
      }

      const matchingOrders = await Order.find(orderQuery).select("_id");
      const matchingOrderIds = matchingOrders.map((o) => o._id);

      if (matchingOrderIds.length > 0) {
        query.orderIds = { $in: matchingOrderIds };
      } else {
        // If filters are provided but no orders match, the manifest list should be empty
        query.orderIds = { $in: [new mongoose.Types.ObjectId()] };
      }
    }

    const manifests = await PickupManifest.find(query)
      .sort({ createdAt: -1 })
      .skip((parseInt(page) - 1) * parseInt(limit))
      .limit(parseInt(limit))
      .populate("userId", "fullname email phoneNumber company userId")
      .populate("orderIds");

    const total = await PickupManifest.countDocuments(query);

    // Get all manifests for the same query (without pagination) to extract unique filter options
    const allMatchingManifests = await PickupManifest.find(query)
      .populate({
        path: "orderIds",
        select: "pickupAddress courierServiceName",
      });

    const pickupLocations = [...new Set(allMatchingManifests.flatMap(m => m.orderIds.map(o => o.pickupAddress?.contactName)).filter(Boolean))];
    const courierServices = [...new Set(allMatchingManifests.flatMap(m => m.orderIds.map(o => o.courierServiceName)).filter(Boolean))];

    return res.status(200).json({
      success: true,
      manifests,
      totalPages: Math.ceil(total / limit),
      total,
      pickupLocations,
      courierServices
    });
  } catch (error) {
    console.error("filterPickupManifestsForAdmin error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

const getManifestOrders = async (req, res) => {
  try {
    const { manifestId } = req.params;
    let manifest;
    if (mongoose.Types.ObjectId.isValid(manifestId)) {
      manifest = await PickupManifest.findById(manifestId).populate({
        path: "orderIds",
        populate: { path: "userId", select: "fullname email phoneNumber company userId" }
      });
    } else {
      manifest = await PickupManifest.findOne({ pickupId: manifestId }).populate({
        path: "orderIds",
        populate: { path: "userId", select: "fullname email phoneNumber company userId" }
      });
    }
    if (!manifest) {
      return res.status(404).json({ message: "Manifest not found" });
    }
    return res.status(200).json({
      success: true,
      manifest,
      orders: manifest.orderIds,
    });
  } catch (error) {
    console.error("getManifestOrders error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

const callPickupProvider = async (provider, payload) => {
  try {
    switch (provider) {
      case "Dtdc":
        return { success: true };

      case "Delhivery":
        const { createPickupRequest } = require("../AllCouriers/Delhivery/Courier/couriers.controller");
        return await createPickupRequest(payload.order.pickupAddress.contactName, payload.order.awb_number);

      case "Amazon Shipping":
        return { success: true };

      case "Shree Maruti":
        return { success: true };

      case "Zipypost":
        return { success: true };

      case "Ekart":
        return { success: true };

      default:
        return { success: true };
    }
  } catch (error) {
    console.error(`Pickup provider error for ${provider}:`, error);
    return { success: false, message: error.message };
  }
};

const generatePickupId = async (dateStr, isB2B = false) => {
  const counter = await PickupManifestCounter.findOneAndUpdate(
    { date: "global_counter" },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );

  const prefix = isB2B ? "SHPI-B2B" : "SHPI";
  return `${prefix}-${counter.seq}`;
};

module.exports = {
  assignPickupManifest,
  schedulePickup,
  getPickupManifests,
  getManifestOrders,
  filterPickupManifestsForAdmin,
};
