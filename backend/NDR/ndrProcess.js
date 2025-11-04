const {
  getOrderDetails,
  callShiprocketNdrApi,
  callNimbustNdrApi,
  callEcomExpressNdrApi,
  callSmartshipNdrApi,
  handleDelhiveryNdrAction,
  submitNdrToDtdc,
  submitNdrToAmazon,
  submitNdrToZipypost
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
    rtoAction,
    remarks,
    next_attempt_date,
    phone,
    customer_name
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
      response = await handleDelhiveryNdrAction(awb_number, action,comments);
    } else if (orderDetails.provider === "Dtdc") {
      response = await submitNdrToDtdc(
        awb_number,
        customer_code,
        rtoAction,
        remarks
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
    } else if(orderDetails.partner==="ZipyPost"){
      // Implement ZipyPost NDR API call here
      // console.log("zipypost",req.body);
      const payload={
        action,
        seller_remark:remarks,
        contact_number:phone,
        customer_name,
        address1:consignee_address,
        address2:consignee_address2,
        provider:orderDetails.provider,
      }
      response=await submitNdrToZipypost(awb_number,payload);
    }
     else {
      return res.status(400).json({ error: "Unsupported platform" });
    }
    // console.log("resererer", response);
    res.json({ success: response.success, data: response.error });
  } catch (error) {
    console.log(error);
    res.status(500).json({ data: error.response.error });
  }
};

module.exports = { ndrProcessController };
