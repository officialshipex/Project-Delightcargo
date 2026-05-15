const {
  getOrderDetails,
  callShiprocketNdrApi,
  callNimbustNdrApi,
  callEcomExpressNdrApi,
  callSmartshipNdrApi,
  handleDelhiveryNdrAction,
  submitNdrToDtdc,
  submitNdrToAmazon,
  submitNdrToZipypost,
  submitNdrToShreeMaruti,
  submitNdrToEkart,
  submitNdrToBoxdLogistics,
} = require("../services/ndrService");
const { runNdrTask } = require("../utils/ndrTaskRunner");
const FailedNdrAction = require("../models/FailedNdrAction.model");
const Order = require("../models/newOrder.model");

const ndrProcessController = async (req, res) => {
  const { awb_number } = req.body;

  const orderDetails = await Order.findOne({ awb_number: awb_number });
  if (!orderDetails) {
    return res.status(404).json({ error: "Order not found" });
  }

  try {
    const response = await runNdrTask(orderDetails._id, req.body);

    if (response.success) {
      return res.json({
        success: true,
        message: response.message || "NDR action processed successfully",
        data: response.data,
      });
    } else {
      console.warn(`Immediate NDR failed for ${awb_number}, queuing for retry: ${response.message || response.error}`);
      
      // Move to Action_Requested even if it failed and queued, so user doesn't see it in Action Required
      orderDetails.ndrStatus = "Action_Requested";
      orderDetails.status = "Action_Requested";
      if (!Array.isArray(orderDetails.ndrHistory)) orderDetails.ndrHistory = [];
      
      const queuedEntry = {
        action: req.body.action,
        actionBy: "ShipexIndia",
        remark: req.body.remarks || req.body.comments || "Action Requested (Queued)",
        source: "ShipexIndia",
        date: new Date(),
      };
      orderDetails.ndrHistory.push({ actions: [queuedEntry] });
      await orderDetails.save();

      await FailedNdrAction.create({
        orderId: orderDetails._id,
        awb_number: awb_number,
        action: req.body.action,
        payload: req.body,
        lastError: response.message || response.error || "Initial attempt failed",
        lastAttemptAt: new Date(),
        status: "failed",
      });

      return res.json({
        success: true,
        message: "Action submitted successfully and queued for background processing.",
      });
    }
  } catch (error) {
    console.error("NDR Controller Error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error in NDR processing",
    });
  }
};

const ndrBulkProcessController = async (req, res) => {
  try {
    let payloads = req.body.payloads;

    // Support both wrapped { payloads: [] } and direct array [ ... ]
    if (!payloads && Array.isArray(req.body)) {
      payloads = req.body;
    }

    console.log("Bulk NDR Request Body:", JSON.stringify(req.body, null, 2));
    console.log("Extracted Payloads:", payloads);

    if (!payloads || !Array.isArray(payloads) || payloads.length === 0) {
      console.error("Validation failed: payloads is empty or not an array");
      return res
        .status(400)
        .json({
          success: false,
          message: "No NDR payloads provided",
          receivedBody: req.body
        });
    }

    let results = [];
    let successCount = 0;
    let failedCount = 0;
    let successfulOrders = [];
    let failedOrders = [];

    // Loop through each order payload
    for (const p of payloads) {
      const { orderId } = p;
      const order = await Order.findById(orderId);

      if (!order) {
        failedCount++;
        failedOrders.push(orderId);
        results.push({ orderId, success: false, message: "Order not found" });
        continue;
      }

      try {
        // Trigger initial API call
        const apiResponse = await runNdrTask(order._id, p);
        const isSuccess = apiResponse?.success === true;

        if (isSuccess) {
          successCount++;
          successfulOrders.push(orderId);
          results.push({
            orderId,
            awb: order.awb_number,
            success: true,
            message: apiResponse?.message || "Processed successfully",
          });
        } else {
          // If immediate API call fails, queue for background retry
          console.warn(`Bulk NDR failed for ${order.awb_number}, queuing: ${apiResponse?.message || apiResponse?.error}`);
          
          // Move to Action_Requested even if it failed and queued
          order.ndrStatus = "Action_Requested";
          order.status="Action_Requested";
          if (!Array.isArray(order.ndrHistory)) order.ndrHistory = [];
          
          const queuedEntry = {
            action: p.action,
            actionBy: "ShipexIndia",
            remark: p.remarks || p.comments || "Action Requested (Queued)",
            source: "ShipexIndia",
            date: new Date(),
          };
          order.ndrHistory.push({ actions: [queuedEntry] });
          await order.save();

          await FailedNdrAction.create({
            orderId: order._id,
            awb_number: order.awb_number,
            action: p.action,
            payload: p,
            lastError: apiResponse?.message || apiResponse?.error || "Initial attempt failed",
            lastAttemptAt: new Date(),
            status: "failed",
          });

          // We count it as "processed" (queued) for the user to avoid "error" panic
          successCount++;
          successfulOrders.push(orderId);
          results.push({
            orderId,
            awb: order.awb_number,
            success: true,
            message: "Queued for background processing",
          });
        }
      } catch (err) {
        console.error("Bulk NDR item error:", err);
        failedCount++;
        failedOrders.push(orderId);
        results.push({
          orderId,
          awb: order.awb_number,
          success: false,
          message: err.message || "Failed",
        });
      }
    }

    const summaryMessage = `Bulk NDR Process Completed:\n✔ Actions processed/queued: ${successCount}\n✖ Failed to identify: ${failedCount}`;

    return res.json({
      success: true,
      message: summaryMessage,
      summary: {
        totalOrders: payloads.length,
        successCount,
        failedCount,
        successfulOrders,
        failedOrders,
      },
      results,
    });
  } catch (error) {
    console.error("Bulk NDR Controller Error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error in bulk NDR",
    });
  }
};

module.exports = { ndrProcessController, ndrBulkProcessController };
