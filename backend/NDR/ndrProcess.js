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
const Order = require("../models/newOrder.model");

const ndrProcessController = async (req, res) => {
  const {
    awb_number,
    action,
    comments,
    scheduled_delivery_date,
    scheduled_delivery_slot,
    mobile,
    consignee_address,
    consignee_address2,
    customer_code,
    remarks,
    next_attempt_date,
    phone,
    customer_name,
    // Change Address fields
    new_address,
    new_address2,
    new_phone,
    new_pincode,
    // BoxdLogistics specific
    updated_city,
    updated_state,
    action_date,
    links,
  } = req.body;

  // console.log("awb",awb_number)
  const orderDetails = await Order.findOne({ awb_number: awb_number });
  // console.log("dtdc", req.body);
  // const orderDetails = getOrderDetails(orderId);

  if (!orderDetails) {
    return res.status(404).json({ error: "Order not found" });
  }
  // console.log("ordrer",orderDetails)
  try {
    let response;
    if (orderDetails.platform === "shiprocket") {
      response = await callShiprocketNdrApi(orderDetails);
    } else if (orderDetails.platform === "nimbust") {
      response = await callNimbustNdrApi(orderDetails);
    } else if (orderDetails.provider === "EcomExpress") {
      response = await callEcomExpressNdrApi(
        awb_number,
        action,
        comments,
        scheduled_delivery_date,
        scheduled_delivery_slot,
        mobile,
        consignee_address
      );
    } else if (orderDetails.provider === "Delhivery") {
      response = await handleDelhiveryNdrAction(awb_number, action, comments);
    } else if (orderDetails.provider === "Dtdc") {
      response = await submitNdrToDtdc(
        awb_number,
        customer_code,
        action,
        comments
      );
    } else if (orderDetails.provider === "Amazon Shipping") {
      response = await submitNdrToAmazon(
        awb_number,
        action,
        comments,
        scheduled_delivery_date
      );
      // console.log("re", response);
    } else if (orderDetails.provider === "Smartship") {
      // console.log("smartship");
      response = await callSmartshipNdrApi(
        awb_number,
        action,
        comments,
        next_attempt_date,
        phone
      );
    } else if (orderDetails.provider === "Shree Maruti") {
      const payload = {
        awb_number,
        actionType: action,
        remarks: comments,
        consignee_address: new_address || consignee_address,
        phone: new_phone || phone,
      };
      response = await submitNdrToShreeMaruti(payload);
    } else if (orderDetails.provider === "Ekart") {
      response = await submitNdrToEkart({
        awb_number,
        action,
        comments,
        new_address,
        new_address2,
        customer_name,
        new_phone,
        new_pincode,
        scheduled_delivery_date,
        links,
      });
    } else if (orderDetails.partner === "ZipyPost") {
      const payload = {
        action,
        seller_remark: remarks,
        contact_number: phone,
        customer_name,
        address1: consignee_address,
        address2: consignee_address2,
        provider: orderDetails.provider,
      };
      response = await submitNdrToZipypost(awb_number, payload);
    } else if (orderDetails.partner === "BoxdLogistics") {
      response = await submitNdrToBoxdLogistics({
        awb_number,
        action,
        remarks: remarks || comments,
        action_date,
        updated_address_line1: new_address || consignee_address,
        updated_address_line2: new_address2 || consignee_address2,
        updated_city,
        updated_state,
        updated_pincode: new_pincode,
        updated_mobile: new_phone || phone,
      });
    } else {
      return res.status(400).json({ error: "Unsupported platform" });
    }
    // console.log("resererer", response.failedOrders);
    res.json({ success: response.success, data: response.error });
  } catch (error) {
    console.log(error);
    res.status(500).json({ data: error.response.error });
  }
};

const ndrBulkProcessController = async (req, res) => {
  try {
    const { payloads } = req.body;
    // console.log("Bulk NDR Payloads:", payloads);
    if (!payloads || !Array.isArray(payloads) || payloads.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "No NDR payloads provided" });
    }

    let results = [];
    let successCount = 0;
    let failedCount = 0;
    let successfulOrders = [];
    let failedOrders = [];

    // Loop through each order payload
    for (const p of payloads) {
      const {
        orderId,
        action,
        remarks,
        comments,
        scheduledDate,
        scheduled_delivery_date,
        deliverySlot,
        phone,
        customer_name,
        address1,
        address2,
      } = p;

      const order = await Order.findById(orderId);

      if (!order) {
        failedCount++;
        failedOrders.push(orderId);

        results.push({
          orderId,
          awb: null,
          provider: null,
          success: false,
          message: "Order not found",
        });
        continue;
      }

      let awb_number = order.awb_number;
      let provider = order.provider;
      let partner = order.partner;
      let platform = order.platform;

      let apiResponse;

      try {
        /** ---------------- PROVIDER-WISE BULK NDR PROCESS ---------------- **/

        if (platform === "shiprocket") {
          apiResponse = await callShiprocketNdrApi(order);
        } else if (platform === "nimbust") {
          apiResponse = await callNimbustNdrApi(order);
        } else if (provider === "EcomExpress") {
          apiResponse = await callEcomExpressNdrApi(
            awb_number,
            action,
            remarks || comments,
            scheduled_delivery_date || scheduledDate,
            deliverySlot,
            phone,
            null
          );
        } else if (provider === "Delhivery") {
          apiResponse = await handleDelhiveryNdrAction(
            awb_number,
            action,
            remarks || comments
          );
        } else if (provider === "Dtdc") {
          apiResponse = await submitNdrToDtdc(
            awb_number,
            order.orderId,
            action,
            remarks
          );
        } else if (provider === "Amazon Shipping") {
          apiResponse = await submitNdrToAmazon(
            awb_number,
            action,
            remarks || comments,
            scheduled_delivery_date || scheduledDate
          );
        } else if (provider === "Smartship") {
          apiResponse = await callSmartshipNdrApi(
            awb_number,
            action,
            remarks,
            scheduledDate,
            phone
          );
        } else if (provider === "Shree Maruti") {
          const payload = {
            awb_number,
            actionType: action,
            remarks: remarks,
            consignee_address: address1,
            phone,
          };
          apiResponse = await submitNdrToShreeMaruti(payload);
        } else if (partner === "ZipyPost") {
          const customAction =
            action === "RE-ATTEMPT"
              ? "Re-Attempt"
              : action === "CHANGE CONTACT"
                ? "Change Contact"
                : action === "CHANGE ADDRESS"
                  ? "Change Address"
                  : action;
          const payload = {
            action: customAction,
            seller_remark: remarks,
            contact_number: phone,
            customer_name,
            address1,
            address2,
            provider,
          };
          apiResponse = await submitNdrToZipypost(awb_number, payload);
        } else if (partner === "BoxdLogistics") {
          apiResponse = await submitNdrToBoxdLogistics({
            awb_number,
            action,
            remarks,
            action_date: null,
            updated_address_line1: address1,
            updated_address_line2: address2,
            updated_city: p.updated_city || null,
            updated_state: p.updated_state || null,
            updated_pincode: p.new_pincode || null,
            updated_mobile: phone,
          });
        } else {
          apiResponse = { success: false, message: "Unsupported provider" };
        }

        /** ---------------- STORE RESULT ---------------- **/

        const isSuccess = apiResponse?.success === true;

        if (isSuccess) {
          successCount++;
          successfulOrders.push(orderId);
        } else {
          failedCount++;
          failedOrders.push(orderId);
        }

        results.push({
          orderId,
          awb: awb_number,
          provider,
          success: isSuccess,
          message: apiResponse?.message || apiResponse?.error || "Completed",
        });
      } catch (err) {
        failedCount++;
        failedOrders.push(orderId);

        console.error("NDR bulk error:", err);

        results.push({
          orderId,
          awb: awb_number,
          provider,
          success: false,
          message: err?.response?.data?.error || err.message || "Failed",
        });
      }
    }
    const summaryMessage = `Bulk NDR Process Completed:\n✔ Successfully processed: ${successCount}\n✖ Failed to process: ${failedCount}\n\nPlease review failed shipments for more details.`;

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
