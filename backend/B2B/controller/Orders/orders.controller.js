const Order = require("../../../models/newOrder.model");
const User = require("../../../models/User.model");
const Wallet = require("../../../models/wallet");
const WalletTransaction = require("../../../models/WalletTransaction.model");
const mongoose = require("mongoose");
const AllocatedRole = require("../../../models/allocateRoleSchema");
const { createDelhiveryPickupRequest, cancelDelhiveryShipmentB2B } = require("../Couriers/AllCouriers/Delhivery/Courier/couriers.controller")

const adminB2BOrders = async (req, res) => {
  try {
    const {
      orderId,
      status,
      awbNumber,
      startDate,
      endDate,
      searchQuery, // <-- add this
      paymentType,
      pickupContactName,
      courier,
      userId,
      page = 1,
      limit = 20,
    } = req.query;

    const filter = {};
    filter.orderType = "B2B";
    // Order-level filters
    if (orderId && !isNaN(orderId)) {
      filter.orderId = Number(orderId);
    }

    if (status && status !== "All") {
      const statusArray = Array.isArray(status)
        ? status
        : status.split(",").map((s) => s.trim());

      filter.status = { $in: statusArray };
    }

    if (awbNumber) filter.awb_number = { $regex: awbNumber, $options: "i" };

    if (startDate && endDate) {
      const start = new Date(startDate);
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      filter.createdAt = { $gte: start, $lte: end };
    }

    if (paymentType) filter["paymentDetails.method"] = paymentType;
    if (courier) {
      const couriers = courier.split(",").map((c) => c.trim());
      filter.courierServiceName = { $in: couriers };
    }
    if (pickupContactName) {
      const names = pickupContactName.split(",").map((n) => n.trim());
      filter["pickupAddress.contactName"] = { $in: names };
    }

    let allocatedUserIds = [];

    // Employee role filtering logic
    if (req.employee && req.employee.employeeId) {
      const allocations = await AllocateRole.find({
        employeeId: req.employee.employeeId,
      });

      allocatedUserIds = allocations.map((a) => a.sellerMongoId.toString());

      if (allocatedUserIds.length === 0) {
        return res.json({
          orders: [],
          totalPages: 0,
          totalCount: 0,
          currentPage: parseInt(page),
          courierServices: [],
          pickupLocations: [],
        });
      }
    }

    // User filtering logic
    if (userId) {
      const objectId = new mongoose.Types.ObjectId(userId);
      if (
        allocatedUserIds.length > 0 &&
        !allocatedUserIds.includes(userId.toString())
      ) {
        return res.json({
          orders: [],
          totalPages: 0,
          totalCount: 0,
          currentPage: parseInt(page),
          courierServices: [],
          pickupLocations: [],
        });
      }
      filter.userId = objectId;
    }

    if (searchQuery) {
      const userFilter = {
        $or: [
          { fullname: { $regex: searchQuery, $options: "i" } },
          { email: { $regex: searchQuery, $options: "i" } },
          { phoneNumber: { $regex: searchQuery, $options: "i" } },
        ],
      };
      const users = await User.find(userFilter).select("_id");
      const matchedIds = users.map((u) => u._id.toString());

      let validUserIds = matchedIds;
      if (allocatedUserIds.length > 0) {
        validUserIds = matchedIds.filter((id) => allocatedUserIds.includes(id));
      }

      if (validUserIds.length > 0) {
        filter.userId = {
          $in: validUserIds.map((id) => new mongoose.Types.ObjectId(id)),
        };
      } else {
        return res.json({
          orders: [],
          totalPages: 0,
          totalCount: 0,
          currentPage: parseInt(page),
          courierServices: [],
          pickupLocations: [],
        });
      }
    } else if (userId) {
      const objectId = new mongoose.Types.ObjectId(userId);
      if (
        allocatedUserIds.length > 0 &&
        !allocatedUserIds.includes(userId.toString())
      ) {
        return res.json({
          orders: [],
          totalPages: 0,
          totalCount: 0,
          currentPage: parseInt(page),
          courierServices: [],
          pickupLocations: [],
        });
      }
      filter.userId = objectId;
    } else if (allocatedUserIds.length > 0) {
      filter.userId = {
        $in: allocatedUserIds.map((id) => new mongoose.Types.ObjectId(id)),
      };
    }

    // Pagination & fetch
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const totalCount = await Order.countDocuments(filter);
    // Conditional sorting logic
    let sortOption = { shipmentCreatedAt: -1 };
    if (
      filter.status &&
      filter.status.$in &&
      filter.status.$in.includes("new")
    ) {
      sortOption = { createdAt: -1 };
    } else if (filter.status === "new") {
      sortOption = { createdAt: -1 };
    }
    const orders = await Order.find(filter)
      .sort(sortOption)
      .populate("userId", "fullname email phoneNumber company userId")
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    const totalPages = Math.ceil(totalCount / limit);

    const matchStage = { ...filter };

    // Aggregation: Couriers
    const couriersData = await Order.aggregate([
      { $match: matchStage },
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

    const couriers = couriersData.map((c) => c.courierServiceName);

    // Aggregation: Pickup Locations
    const pickupLocations = await Order.aggregate([
      {
        $match: {
          ...matchStage,
          "pickupAddress.contactName": { $exists: true, $ne: "" },
        },
      },
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
      currentPage: parseInt(page),
      courierServices: couriers,
      pickupLocations,
    });
  } catch (error) {
    console.error("Error filtering orders:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

const userB2BOrders = async (req, res) => {
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

    // console.log("reqq",req.query)
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

    // Fetch ONLY B2B Orders
    andConditions.push({ orderType: "B2B" });

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

const generatePickupController = async (req, res) => {
  try {
    const { orderIds } = req.body;
    console.log("order pickup", orderIds)

    if (!Array.isArray(orderIds) || orderIds.length === 0) {
      return res.status(400).json({ message: "orderIds array is required" });
    }

    const results = [];

    for (const orderId of orderIds) {
      const order = await Order.findById(orderId)
        .populate("pickupAddress")
        .lean();

      if (!order) {
        results.push({
          orderId,
          success: false,
          error: "Order not found",
        });
        continue;
      }

      const provider = order.provider?.toLowerCase().trim();

      let result;

      switch (provider) {
        case "delhivery":
          result = await createDelhiveryPickupRequest(order);
          break;

        default:
          result = {
            orderId,
            success: false,
            error: `Pickup not supported for provider: ${provider}`,
          };
          break;
      }

      results.push(result);
    }

    const hasFailure = results.some((r) => r.success === false);

    res.status(hasFailure ? 207 : 200).json({
      success: !hasFailure,
      message: hasFailure
        ? "Pickup processed with partial failures"
        : "Pickup generated successfully",
      results,
    });
  } catch (error) {
    console.error("Pickup controller error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to generate pickup request",
    });
  }
};



// ================================================================
// CANCEL B2B ORDER — mirrors the B2C equivalent's structure
// (API/Controller/cancelledOrder.controller.js: cancelOrdersAtBooked),
// adapted for B2B's own status/field names (manifestJobId/lrn instead of
// awb_number as the primary shipment reference pre-delivery, and provider
// dispatch currently only covers Delhivery — see the switch below for why).
// ================================================================
const cancelB2BOrder = async (req, res) => {
  try {
    const { id } = req.params;

    const order = await Order.findById(id);
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }
    if (order.orderType !== "B2B") {
      return res.status(400).json({ success: false, message: "Not a B2B order" });
    }
    if (order.status === "Cancelled") {
      return res.status(400).json({ success: false, message: "Order is already cancelled" });
    }

    // Nothing has been booked with any provider yet — no external call
    // needed, no charge was ever applied, just cancel locally. This must be
    // an atomic conditional update on status: "new" specifically, not a
    // plain write — "processing" is a transient lock state owned
    // exclusively by createDelhiveryB2BShipment's Phase 1 (it's the only
    // thing that ever puts an order into or takes it out of "processing").
    // A plain write here could land mid-booking and either get silently
    // overwritten by that flow's later "Booked" write (so the cancellation
    // is lost and the wallet still gets charged), or win the race *after*
    // a real shipment was already booked and paid for, leaving the order
    // marked Cancelled while an actual live, un-refunded shipment exists.
    if (order.status === "new") {
      const cancelledOrder = await Order.findOneAndUpdate(
        { _id: order._id, status: "new" },
        {
          $set: { status: "Cancelled" },
          $push: {
            tracking: {
              status: "Cancelled",
              Instructions: "Cancelled by user before booking",
              StatusLocation: order.pickupAddress?.city || "N/A",
              // Matches the rest of the codebase's convention: stored
              // pre-shifted to IST since the UI displays it as-is.
              StatusDateTime: new Date(Date.now() + 5.5 * 60 * 60 * 1000),
            },
          },
        },
        { new: true }
      );
      if (cancelledOrder) {
        return res.status(200).json({ success: true, message: "Order cancelled successfully" });
      }
      // Someone else (a booking attempt) claimed the order between our read
      // and this update — fall through so the status is re-read fresh.
      order.status = "processing";
    }

    if (order.status === "processing") {
      return res.status(409).json({
        success: false,
        message: "Order is currently being processed — please try again in a few moments.",
      });
    }

    if (!["Booked", "Ready To Ship", "Not Picked"].includes(order.status)) {
      return res.status(400).json({
        success: false,
        message: `Order in status "${order.status}" cannot be cancelled`,
      });
    }

    // `partner` (the booking channel/aggregator) must win over `provider`
    // (the underlying carrier) when they differ — e.g. an order can have
    // partner: "Shiprocket", provider: "Delhivery" when it was booked
    // *through* Shiprocket Cargo's aggregator using Delhivery as the
    // underlying carrier. That shipment's LRN lives in Shiprocket's own
    // account/namespace, not ours, so it must be cancelled via Shiprocket's
    // API, not by calling Delhivery directly with our own B2B credentials.
    // Mirrors the same partner-before-provider precedence already
    // established for B2C in cancelledOrder.controller.js.
    const isDirectDelhivery = !order.partner || order.partner === "Delhivery";
    const dispatchKey = isDirectDelhivery ? (order.provider || order.partner) : order.partner;

    let cancelResult;
    switch (dispatchKey) {
      case "Delhivery":
        // Delhivery's own docs: cancelling by LRN "cancel[s] the shipment
        // altogether so that it does not even get picked up" — so this one
        // call covers cancellation both before and after pickup is
        // scheduled. It requires an LRN, which only exists once the async
        // manifest job resolves (order.status === "Booked" doesn't
        // guarantee that yet — manifestJobId is set immediately, lrn is
        // set later by getDelhiveryB2BShipmentDetailsInternal/the webhook).
        if (!order.lrn) {
          return res.status(400).json({
            success: false,
            message: "Shipment is still being processed by Delhivery — please try again in a few minutes.",
          });
        }
        cancelResult = await cancelDelhiveryShipmentB2B(order.lrn, order.courierServiceName);
        break;
      default:
        return res.status(400).json({
          success: false,
          message: `Cancellation not yet supported for provider "${dispatchKey || "unknown"}"`,
        });
    }

    if (cancelResult?.success === false) {
      return res.status(400).json({
        success: false,
        message: cancelResult.message || "Failed to cancel shipment with courier",
      });
    }

    // Atomically flip to Cancelled + walletRefunded — guarded so a
    // concurrent process (e.g. the async manifest-status fallback or the
    // Delhivery webhook landing around the same time) can't refund twice.
    const updatedOrder = await Order.findOneAndUpdate(
      { _id: order._id, walletRefunded: { $ne: true } },
      {
        $set: { status: "Cancelled", walletRefunded: true },
        $push: {
          tracking: {
            status: "Cancelled",
            Instructions: "Cancelled by user",
            StatusLocation: order.pickupAddress?.city || "N/A",
            StatusDateTime: new Date(Date.now() + 5.5 * 60 * 60 * 1000),
          },
        },
      },
      { new: true }
    );

    if (updatedOrder) {
      if (updatedOrder.walletDeducted) {
        const refundAmount = Number(updatedOrder.totalFreightCharges) || 0;
        if (refundAmount > 0) {
          const user = await User.findById(updatedOrder.userId);
          const wallet = await Wallet.findById(user.Wallet).select("balance");
          const newBalance = (wallet.balance || 0) + refundAmount;

          await Promise.all([
            Wallet.findByIdAndUpdate(user.Wallet, { $inc: { balance: refundAmount } }),
            WalletTransaction.create({
              walletId: user.Wallet,
              channelOrderId: updatedOrder.orderId,
              category: "credit",
              // Matches cancelB2BOrder's Shiprocket-cancel-refund
              // counterpart (couriers.controller.js) — was missing here,
              // so the credit entry in the wallet passbook had no AWB to
              // tie it back to the shipment it refunded.
              awb_number: updatedOrder.awb_number,
              amount: refundAmount,
              balanceAfterTransaction: newBalance,
              description: "Freight Charges Received",
              date: new Date(),
            }),
          ]);
        }
      }
    } else {
      // Already refunded/cancelled by a concurrent process — just ensure
      // the status reflects it, without running the refund logic again.
      await Order.findOneAndUpdate(
        { _id: order._id, status: { $ne: "Cancelled" } },
        {
          $set: { status: "Cancelled" },
          $push: {
            tracking: {
              status: "Cancelled",
              Instructions: "Cancelled by user",
              StatusLocation: order.pickupAddress?.city || "N/A",
              StatusDateTime: new Date(Date.now() + 5.5 * 60 * 60 * 1000),
            },
          },
        }
      );
    }

    return res.status(200).json({ success: true, message: "Order cancelled successfully" });
  } catch (error) {
    console.error("❌ Error cancelling B2B order:", error);
    return res.status(500).json({ success: false, message: error.message || "Internal server error" });
  }
};

module.exports = { adminB2BOrders, userB2BOrders, generatePickupController, cancelB2BOrder };
