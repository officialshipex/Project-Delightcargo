const Order = require("../models/newOrder.model");
const PickupManifest = require("../models/pickupManifest.model");
const PickupManifestCounter = require("../models/pickupManifestCounter.model");

const schedulePickup = async (req, res) => {
  try {
    const { orderId, pickupDate } = req.body;

    if (!orderId || !pickupDate) {
      return res
        .status(400)
        .json({ message: "orderId and pickupDate required" });
    }

    const order = await Order.findById(orderId);

    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    if (!order.provider) {
      return res.status(400).json({ message: "Provider not found in order" });
    }

    // 1️⃣ Call provider pickup API
    const pickupResponse = await callPickupProvider(order.provider, {
      order,
      pickupDate,
    });

    if (!pickupResponse?.success) {
      return res
        .status(400)
        .json({ message: "Pickup scheduling failed at provider" });
    }

    // 2️⃣ Normalize pickup date (date-based manifest)
    const pickupDateObj = new Date(pickupDate);
    pickupDateObj.setHours(0, 0, 0, 0);

    let manifest = await PickupManifest.findOne({
      userId: order.userId,
      pickupDate: pickupDateObj,
    });

    // 3️⃣ Create new manifest if not exists
    if (!manifest) {
      const dateStr = pickupDateObj.toISOString().split("T")[0];
      const pickupId = await generatePickupId(dateStr);

      manifest = await PickupManifest.create({
        userId: order.userId,
        pickupId,
        pickupDate: pickupDateObj,
        status: "Pickup_Scheduled",
        orderIds: [order._id],
        awb_numbers: order.awb_number ? [order.awb_number] : [],
        providers: [order.provider],
        courierServiceNames: order.courierServiceName
          ? [order.courierServiceName]
          : [],
      });
    } else {
      // 4️⃣ Update existing manifest safely (NO DUPLICATES)

      if (!manifest.orderIds.some((id) => id.equals(order._id))) {
        manifest.orderIds.push(order._id);
      }

      if (
        order.awb_number &&
        !manifest.awb_numbers.includes(order.awb_number)
      ) {
        manifest.awb_numbers.push(order.awb_number);
      }

      if (order.provider && !manifest.providers.includes(order.provider)) {
        manifest.providers.push(order.provider);
      }

      if (
        order.courierServiceName &&
        !manifest.courierServiceNames.includes(order.courierServiceName)
      ) {
        manifest.courierServiceNames.push(order.courierServiceName);
      }

      manifest.status = "Pickup_Scheduled";
    //   await manifest.save();
    }

    // 5️⃣ Update order status
    order.status = "Ready To Ship";
    // await order.save();
// console.log("manifest",manifest)
    return res.status(200).json({
      message: "Pickup scheduled successfully",
      pickupId: manifest.pickupId,
    });
  } catch (error) {
    console.error("schedulePickup error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

const schedulePickupDtdc = async ({ order, pickupDate }) => {
  return { success: true };
};

const callPickupProvider = async (provider, payload) => {
  switch (provider) {
    case "Dtdc":
      return schedulePickupDtdc(payload);

    default:
      throw new Error(`Pickup not supported for provider ${provider}`);
  }
};

const generatePickupId = async (dateStr) => {
  const counter = await PickupManifestCounter.findOneAndUpdate(
    { date: dateStr },
    { $inc: { seq: 1 } },
    { new: true, upsert: true },
  );

  return `SHPI-${counter.seq}`;
};

module.exports = { schedulePickup };
