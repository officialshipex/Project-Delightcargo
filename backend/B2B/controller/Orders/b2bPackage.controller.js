const Order = require("../../../models/newOrder.model");

/* =========================================
   INTERNAL HELPERS (SAME FILE)
========================================= */
const VOLUMETRIC_DIVISOR = 5000;

const num = (v) => Number(v) || 0;

const calculateDeadWeight = (packages = []) => {
  let total = 0;
  for (const p of packages) {
    total += num(p.noOfBox) * num(p.weightPerBox);
  }
  return Number(total.toFixed(2));
};

const calculateVolumetricWeight = (packages = []) => {
  let total = 0;

  for (const p of packages) {
    const volPerBox =
      (num(p.length) * num(p.width) * num(p.height)) /
      VOLUMETRIC_DIVISOR;

    total += volPerBox * num(p.noOfBox);
  }

  return Number(total.toFixed(2));
};

/* =========================================
   GET B2B PACKAGE DETAILS
========================================= */
exports.getB2BPackages = async (req, res) => {
  try {
    const { orderId } = req.params;
    // console.log("orderId", orderId);

    const order = await Order.findById(orderId).select(
      "B2BPackageDetails"
    );

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    const details = order.B2BPackageDetails || {};

    res.json({
      success: true,
      applicableWeight: details.applicableWeight || 0,
      volumetricWeight: details.volumetricWeight || 0,
      packages: details.packages || [],
    });
  } catch (err) {
    console.error("GET B2B PACKAGES ERROR:", err);
    res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};

/* =========================================
   UPDATE B2B PACKAGE DETAILS
========================================= */
exports.updateB2BPackages = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { packages } = req.body;

    if (!Array.isArray(packages)) {
      return res.status(400).json({
        success: false,
        message: "Packages must be an array",
      });
    }

    const deadWeight = calculateDeadWeight(packages);
    const volumetricWeight =
      calculateVolumetricWeight(packages);

    const applicableWeight = Math.max(
      deadWeight,
      volumetricWeight
    );

    const order = await Order.findByIdAndUpdate(
      orderId,
      {
        $set: {
          "B2BPackageDetails.packages": packages,
          "B2BPackageDetails.deadWeight": deadWeight,
          "B2BPackageDetails.volumetricWeight":
            volumetricWeight,
          "B2BPackageDetails.applicableWeight":
            applicableWeight,
        },
      },
      { new: true }
    );

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    res.json({
      success: true,
      deadWeight,
      volumetricWeight,
      applicableWeight,
    });
  } catch (err) {
    console.error("UPDATE B2B PACKAGES ERROR:", err);
    res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};
