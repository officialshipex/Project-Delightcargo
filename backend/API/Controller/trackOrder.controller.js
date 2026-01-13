const Order = require("../../models/newOrder.model");
const User = require("../../models/User.model");

const trackOrder = async (req, res) => {
  try {
    const { userId, awb } = req.body;

    // Validate input
    if (!userId || !awb) {
      return res.status(400).json({
        success: false,
        message: "Both userId and awb are required in the request body.",
      });
    }

    if (!/^\d{5}$/.test(userId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid userId format. It must be a 6-digit number.",
      });
    }

    const user = await User.findOne({ userId: userId });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    // Find order by AWB number and userId
    const order = await Order.findOne({ awb_number: awb, userId: user._id });
    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found or invalid userId/AWB combination.",
      });
    }
    // console.log("order",order)
    // Format tracking details
    const tracking = (order.tracking || [])
      .sort((a, b) => new Date(a.StatusDateTime) - new Date(b.StatusDateTime))
      .map((t) => ({
        status: t.status || t.Instructions || "Unknown",
        location: t.StatusLocation || null,
        dateTime: t.StatusDateTime || null,
        instructions: t.Instructions || null,
      }));

    // Build response object
    const responseData = {
      awb_number: order.awb_number,
      orderId: order.orderId,
      status: order.status,
      courierServiceName: order.courierServiceName,
      tracking,
    };

    res.status(200).json({
      success: true,
      data: responseData,
    });
  } catch (error) {
    console.error("Error fetching tracking details:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

module.exports = trackOrder;
