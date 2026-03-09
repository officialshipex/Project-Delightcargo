const axios = require("axios");
const DELHIVERY_API_URL = process.env.DELHIVERY_URL;
const DEL_API_TOKEN = process.env.DEL_API_TOKEN;
const Order = require("../models/newOrder.model");
const moment = require("moment");
const FormData = require("form-data");
const {
  getToken,
} = require("../AllCouriers/ShreeMaruti/Authorize/shreeMaruti.controller");
const {
  getAuthToken,
} = require("../AllCouriers/Zipypost/Authorize/zipyPost.controller");
const {
  getAccessToken,
} = require("../AllCouriers/SmartShip/Authorize/smartShip.controller");
const {
  getAmazonAccessToken,
} = require("../AllCouriers/Amazon/Authorize/saveCourierController");
const {
  getDTDCAuthToken,
} = require("../AllCouriers/DTDC/Authorize/saveCourierContoller");
const {
  getAccessToken: getEkartAccessToken,
} = require("../AllCouriers/Ekart/Authorize/Ekart.controller");

const ordersDatabase = [
  {
    orderId: 1,
    platform: "shiprocket",
    details: "Order details for Shiprocket",
  },
  { orderId: 2, platform: "nimbust", details: "Order details for Nimbust" },
];

const getOrderDetails = (orderId) => {
  return ordersDatabase.find((order) => order.orderId === orderId);
};

// Function to call Shiprocket NDR API
const callShiprocketNdrApi = async (orderDetails) => {
  try {
    const response = await axios.post(
      "https://api.shiprocket.in/v1/external/ndr",
      orderDetails
    );
    return response.data;
  } catch (error) {
    throw new Error("Error calling Shiprocket NDR API");
  }
};

// Function to call Nimbust NDR API
const callNimbustNdrApi = async (orderDetails) => {
  try {
    const response = await axios.post(
      "https://api.nimbust.com/v1/ndr",
      orderDetails
    );
    return response.data;
  } catch (error) {
    throw new Error("Error calling Nimbust NDR API");
  }
};

//Function to call Ecom Express NDR API
const callEcomExpressNdrApi = async (
  awb_number,
  action,
  comments,
  scheduled_delivery_date,
  scheduled_delivery_slot,
  mobile,
  consignee_address
) => {
  try {
    let instructionValue = "";

    if (action === "RE-ATTEMPT") {
      instructionValue = "RAD";
    } else if (action === "RTO") {
      instructionValue = "RTO";
    } else {
      return {
        success: false,
        error: "Invalid action. Only 'RE-ATTEMPT' or 'RTO' are supported",
      };
    }

    const shipment = {
      awb: awb_number,
      instruction: instructionValue,
      comments,
    };
    const order = await Order.findOne({ awb_number });
    if (action === "RE-ATTEMPT") {
      if (!scheduled_delivery_date || !scheduled_delivery_slot) {
        return {
          success: false,
          error:
            "For 'RE-ATTEMPT', 'scheduled_delivery_date' and 'scheduled_delivery_slot' are required",
        };
      }

      shipment.scheduled_delivery_date = scheduled_delivery_date;
      shipment.scheduled_delivery_slot = scheduled_delivery_slot;
      console.log("consignement address", consignee_address);

      // Fallback to order.receiverAddress if not provided in the API call
      const isEmptyAddress =
        !consignee_address ||
        !consignee_address.CA1?.trim() ||
        !consignee_address.CA2?.trim() ||
        !consignee_address.CA4?.trim();
      // !consignee_address.pincode?.trim();

      if (isEmptyAddress) {
        const r = order.receiverAddress;
        consignee_address = {
          CA1: r.address || "",
          CA2: `${r.city || ""}, ${r.state || ""}`,
          CA3: "", // optional, fill if needed
          CA4: r.contactName || "",
          // pincode: r.pinCode || "",
        };
      }
      console.log(consignee_address);
      const { CA1, CA2, CA3, CA4 } = consignee_address;
      if (!CA1 || !CA2 || !CA4) {
        return {
          success: false,
          error:
            "Incomplete consignee_address. Fields CA1, CA2, CA4, and pincode are required",
        };
      }

      shipment.consignee_address = consignee_address;

      // Fallback to order.receiverAddress.phoneNumber if mobile not given
      if (!mobile) {
        mobile = order.receiverAddress?.phoneNumber;
      }

      if (!mobile) {
        return {
          success: false,
          error: "Mobile number is required but not found in request or order",
        };
      }

      shipment.mobile = mobile;
    } else if (action === "RTO") {
      // RTO needs no extra data, just log that it's being returned
      // No changes to the shipment object needed
    } else {
      return {
        success: false,
        error: "Invalid action. Only 'RE-ATTEMPT' or 'RTO' are supported",
      };
    }

    const form = new FormData();
    form.append("username", process.env.ECOMEXPRESS_GMAIL);
    form.append("password", process.env.ECOMEXPRESS_PASS);
    form.append("json_input", JSON.stringify([shipment]));

    console.log("ECOMEXPRESS_GMAIL", process.env.ECOMEXPRESS_GMAIL);
    console.log("ECOMEXPRESS_PASS", process.env.ECOMEXPRESS_PASS);
    console.log("json_input", JSON.stringify([shipment]));

    const response = await axios.post(
      "https://api.ecomexpress.in/apiv2/ndr_resolutions/",
      form,
      {
        headers: {
          ...form.getHeaders(),
        },
      }
    );

    console.log("resoso", response.data);

    if (response.data[0].status) {
      if (!Array.isArray(order.ndrHistory)) {
        order.ndrHistory = [];
      }
      const attemptCount = order.ndrHistory?.length || 0;

      // Step 7: Save history entry
      const ndrHistoryEntry = {
        date: new Date(),
        action,
        remark: comments,
        // Fallback to existing remark if tracking is empty
        attempt: attemptCount + 1,
      };

      order.ndrStatus = "Action_Requested";
      order.ndrHistory.push(ndrHistoryEntry);
      await order.save();
    }

    return {
      success: true,
      error: "NDR submitted successfully",
      data: response.data,
    };
  } catch (error) {
    console.error("Ecom Express API Error:", error.response.data);
    return {
      success: false,
      error: "Failed to submit NDR",
      details: error.response?.data || error.message,
    };
  }
};

const submitNdrToAmazon = async (
  awb_number,
  action,
  comments,
  scheduled_delivery_date
) => {
  const accessToken = await getAmazonAccessToken();
  try {
    // Map to Amazon's expected format
    let ndrAction;
    if (action === "RE-ATTEMPT") {
      ndrAction = "REATTEMPT";
    } else if (action === "RTO") {
      ndrAction = "RTO";
    } else if (action === "RESCHEDULE") {
      ndrAction = "RESCHEDULE";
    } else {
      return {
        success: false,
        error: "Invalid action. Allowed values: RE-ATTEMPT, RTO, RESCHEDULE",
      };
    }

    const url =
      "https://sellingpartnerapi-eu.amazon.com/shipping/v2/ndrFeedback";

    const headers = {
      "Content-Type": "application/json",
      "x-amz-access-token": accessToken,
      "x-amzn-shipping-business-id": "AmazonShipping_IN",
    };

    const payload = {
      trackingId: awb_number,
      ndrAction,
    };

    // Attach ndrRequestData conditionally
    if (ndrAction === "RESCHEDULE") {
      if (!scheduled_delivery_date) {
        return {
          success: false,
          error: "scheduled_delivery_date is required for RESCHEDULE",
        };
      }
      payload.ndrRequestData = { rescheduleDate: scheduled_delivery_date };
    } else if (ndrAction === "REATTEMPT") {
      if (!comments) {
        return {
          success: false,
          error: "comments are required for RE-ATTEMPT",
        };
      }
      payload.ndrRequestData = { additionalAddressNotes: comments };
    }

    // Send request
    const response = await axios.post(url, payload, { headers });

    // console.log("response", response);
    console.log("Amazon NDR Response:", {
      status: response.status,
      headers: response.headers,
      data: response.data,
    });

    // Check response and update order
    if (response.data) {
      const order = await Order.findOne({ awb_number });

      if (!Array.isArray(order.ndrHistory)) {
        order.ndrHistory = [];
      }

      const attemptCount = order.ndrHistory.length;

      // Prepare new action
      const ndrActionEntry = {
        action,
        actionBy: "ShipexIndia",
        remark: comments || "",
        source: "ShipexIndia",
        date: new Date(),
      };

      // If there is at least one history entry, push into its actions
      if (order.ndrHistory.length > 0) {
        const latestHistory = order.ndrHistory[order.ndrHistory.length - 1];
        if (!Array.isArray(latestHistory.actions)) {
          latestHistory.actions = [];
        }
        latestHistory.actions.push(ndrActionEntry);
      } else {
        // Otherwise, create first entry with actions array
        order.ndrHistory.push({
          actions: [ndrActionEntry],
        });
      }
      order.reattempt = false;
      order.ndrStatus = "Action_Requested";
      await order.save();
    }

    return {
      success: true,
      message: "NDR submitted successfully",
      data: response.data,
    };
  } catch (error) {
    console.error(
      "Amazon NDR Submission Error:",
      error.response?.data.errors[0].details
    );
    return {
      success: false,
      error: error.response?.data.errors[0].details,
      // details: error.response?.data[0].details || error.message,
    };
  }
};

async function handleDelhiveryNdrAction(awb_number, action, comments) {
  if (!awb_number || !action) {
    return {
      success: false,
      error: "Missing required parameters: waybill or act",
    };
  }

  try {
    const order = await Order.findOne({ awb_number });
    if (!order) {
      return { success: false, error: "Order not found" };
    }

    // --- build entry function ---
    const buildActionEntry = (remark) => ({
      action,
      actionBy: "ShipexIndia",
      remark: comments || "NDR Action Requested",
      source: "ShipexIndia",
      date: new Date(),
    });

    // --- helper to push into nested ndrHistory ---
    const pushToNdrHistory = (entry) => {
      if (!Array.isArray(order.ndrHistory)) {
        order.ndrHistory = [];
      }

      const latest = order.ndrHistory[order.ndrHistory.length - 1];
      if (latest.actions.length < 2) {
        latest.actions.push(entry);
      }
    };

    // --- handle RTO (manual) ---
    if (action.toUpperCase() === "RTO") {
      const remark =
        order.tracking.length > 0
          ? order.tracking[order.tracking.length - 1].Instructions
          : "Manual RTO Requested";

      pushToNdrHistory(buildActionEntry(remark));

      order.manualRTOStatus = "Action_Requested";
      order.ndrStatus = "Action_Requested";
      order.status = "Undelivered";
      order.reattempt = false;
      await order.save();

      return {
        success: true,
        manualRTO: true,
        updated_order: order,
      };
    }

    // --- Step 3: Call Delhivery NDR API (non-RTO) ---
    const payload = {
      data: [
        {
          waybill: String(awb_number).trim(),
          act: String(action).trim().toUpperCase(),
        },
      ],
    };

    console.log("payload", payload, DEL_API_TOKEN);
    const response = await axios.post(
      "https://track.delhivery.com/api/p/update",
      payload,
      {
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Token ${DEL_API_TOKEN}`,
        },
      }
    );

    const request_id = response.data?.request_id || null;
    if (!request_id) {
      return { success: false, error: "No request_id returned from API" };
    }

    await new Promise((resolve) => setTimeout(resolve, 5000));

    const ndrStatusResponse = await axios.get(
      `https://track.delhivery.com/api/cmu/get_bulk_upl/${request_id}?verbose=true`,
      {
        headers: { Authorization: `Token ${DEL_API_TOKEN}` },
      }
    );
    // console.log("ndr delhivery",ndrStatusResponse.data.failed_wbns)
    if (ndrStatusResponse.data.status === "Failure") {
      return {
        success: false,
        error: ndrStatusResponse.data.failed_wbns[0].message,
      };
    }

    const { remark } = ndrStatusResponse.data;

    pushToNdrHistory(
      buildActionEntry(
        order.tracking.length > 0
          ? order.tracking[order.tracking.length - 1].Instructions
          : remark
      )
    );

    order.ndrStatus = "Action_Requested";
    order.status = "Undelivered";

    await order.save();

    return {
      success: true,
      request_id,
      ndr_status: ndrStatusResponse.data,
      updated_order: order,
    };
  } catch (error) {
    console.error("Error:", error.response);
    return {
      success: false,
      error: "Failed to request NDR action",
      details: error.response?.data || error.message,
    };
  }
}

const submitNdrToDtdc = async (
  awb_number,
  customer_code,
  rtoAction,
  remarks
) => {
  const failedOrders = [];
  // console.log("awb",awb_number,rtoAction)
  // Validation
  if (!awb_number || !rtoAction) {
    return {
      status: 400,
      error: "Missing required fields",
      failedOrders: [{ awb_number, error: "Required fields are missing" }],
    };
  }

  const rtoActionValue =
    rtoAction === "RE-ATTEMPT" ? "1" : rtoAction === "RTO" ? "2" : rtoAction;

  if (rtoActionValue === "1" && (!remarks || remarks.trim() === "")) {
    return {
      status: 400,
      error: "Remarks required for Re-attempt",
      failedOrders: [{ awb_number, error: "Remarks required for Re-attempt" }],
    };
  }

  const payload = [
    {
      consgNumber: awb_number,
      custCode: process.env.DTDC_USERNAME,
      rtoAction: rtoActionValue,
      remarks: remarks || "",
    },
  ];
  console.log("payload", payload);
  const url = "http://bodb.dtdc.com/ctbs-sraa-api/sraa/validateAndSave";

  try {
    const response = await axios.post(url, payload, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic R0w5NzExOkdMOTcxMUAyMDI1`,
      },
    });

    const result = response.data;
    console.log("DTDC Response:", result);
    console.log(
      "DTDC Payload:",
      result?.result?.invalidConsignmentResponse?.consignmentsNotFoundResponse
    );

    const { validConsignmentResponse, invalidConsignmentResponse } =
      result?.result || {};

    const {
      successConsignmentList = [],
      failedConsignmentList = [],
      pendingApprovalConsignmentList = [],
    } = validConsignmentResponse || {};

    const notFound =
      invalidConsignmentResponse?.consignmentsNotFoundResponse || [];

    // Handle invalid or not found AWB
    if (notFound.length > 0) {
      failedOrders.push({
        awb_number,
        error: "Invalid consignment: Not found in DTDC records",
        details: notFound,
      });
    }

    // Handle failed consignments
    if (failedConsignmentList.length > 0) {
      failedOrders.push({
        awb_number,
        error: "DTDC marked consignment as failed",
        details: failedConsignmentList,
      });
    }

    // Handle success consignments
    if (
      successConsignmentList.some((item) => item.consgNumber === awb_number)
    ) {
      const orderInDb = await Order.findOne({ awb_number });

      if (!orderInDb) {
        return {
          status: 404,
          error: "Order not found in DB",
          failedOrders,
        };
      }

      // --- Build entry ---
      const entry = {
        action: rtoActionValue === "1" ? "RE-ATTEMPT" : "RTO",
        actionBy: "ShipexIndia",
        remark: remarks || "NDR Action Requested",
        source: "ShipexIndia",
        date: new Date(),
      };

      // --- Push to nested ndrHistory ---
      if (!Array.isArray(orderInDb.ndrHistory)) {
        orderInDb.ndrHistory = [];
      }

      const latest = orderInDb.ndrHistory[orderInDb.ndrHistory.length - 1];
      if (latest.actions.length < 2) {
        latest.actions.push(entry);
      }

      // --- Update order status ---
      orderInDb.ndrStatus = "Action_Requested";
      orderInDb.status = "Undelivered";
      orderInDb.reattempt = false;
      await orderInDb.save();

      // console.log("Order updated:", orderInDb);

      return {
        status: 200,
        success: true,
        message: "DTDC NDR submission successful",
        failedOrders,
        dtdcResponse: result,
      };
    }

    // Handle pending approval case
    if (pendingApprovalConsignmentList.length > 0) {
      return {
        status: 202,
        success: true,
        message: "NDR submitted and is pending DTDC approval",
        pendingApproval: pendingApprovalConsignmentList,
        failedOrders,
        dtdcResponse: result,
      };
    }

    // If nothing was successful or pending
    return {
      status: 422,
      success: false,
      error: "Consignment validation failed or not processed",
      failedOrders,
      dtdcResponse: result,
    };
  } catch (error) {
    console.error(
      "DTDC Submission Error:",
      error?.response?.data || error.message
    );
    return {
      status: 500,
      success: false,
      error: "Error occurred while submitting NDR to DTDC",
      details: error?.response?.data || error.message,
    };
  }
};

const submitNdrToShreeMaruti = async ({
  awb_number,
  actionType,
  remarks,
  consignee_address,
  phone,
}) => {
  try {
    let failedOrders = [];
    // console.log(
    //   "shree maruti",
    //   awb_number,
    //   actionType,
    //   remarks,
    //   consignee_address,
    //   phone
    // );
    // --- Validation ---
    if (!awb_number || !actionType) {
      return {
        status: 400,
        error: "Missing required fields",
        failedOrders: [{ awb_number, error: "Required fields are missing" }],
      };
    }
    const actionTypeValue =
      actionType === "RE-ATTEMPT"
        ? "RE-ATTEMPT"
        : actionType === "RTO"
          ? "RTO"
          : actionType;
    console.log("action", actionTypeValue)
    if (actionType === "RE-ATTEMPT" && (!remarks || !remarks.trim())) {
      return {
        status: 400,
        error: "Remarks required for Re-attempt",
        failedOrders: [
          { awb_number, error: "Remarks required for Re-attempt" },
        ],
      };
    }

    // --- Fetch Order ---
    const orderInDb = await Order.findOne({ awb_number });

    if (!orderInDb) {
      return {
        status: 404,
        error: "Order not found in DB",
        failedOrders,
      };
    }

    const receiver = orderInDb.receiverAddress || {};

    // ZIP -- ALWAYS FROM ORDER
    const zip = receiver.pinCode;

    // Other fields from params → fallback to order if not provided
    const address1 =
      consignee_address && consignee_address.trim() !== ""
        ? consignee_address
        : receiver.address;

    const phoneNumber =
      phone && phone.trim() !== "" ? phone : receiver.phoneNumber;

    // --- Payload ---
    const payload = {
      shippingAddress: {
        address1,
        phone: phoneNumber,
        zip,
      },
    };
    const token = await getToken();
    // --- Shree Maruti API URL ---
    const url = `https://apis.delcaper.com/fulfillment/shipper/order/rto-initiate-byseller?awbNumber=${awb_number}&actiontype=${actionTypeValue}`;

    const response = await axios.patch(url, payload, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
    });

    const result = response.data;
    console.log("Shree Maruti NDR Response:", result);

    // --- Handle Failed Response ---
    if (!result || result.success === false) {
      failedOrders.push({
        awb_number,
        error: "Shree Maruti returned failure response",
        details: result,
      });

      return {
        status: 422,
        success: false,
        error: result.message,
        failedOrders,
        shreeMarutiResponse: result,
      };
    }

    // --- SUCCESS ---
    if (result.success === true) {
      const entry = {
        action: actionType,
        actionBy: "ShipexIndia",
        remark: remarks || "NDR Action Requested",
        source: "ShipexIndia",
        date: new Date(),
      };

      if (!Array.isArray(orderInDb.ndrHistory)) {
        orderInDb.ndrHistory = [];
      }

      // Same DTDC logic
      if (orderInDb.ndrHistory.length === 0) {
        orderInDb.ndrHistory.push({ actions: [entry] });
      } else {
        const latest = orderInDb.ndrHistory[orderInDb.ndrHistory.length - 1];

        if (latest.actions.length < 2) {
          latest.actions.push(entry);
        } else {
          orderInDb.ndrHistory.push({ actions: [entry] });
        }
      }

      orderInDb.ndrStatus = "Action_Requested";
      orderInDb.status = "Undelivered";
      orderInDb.reattempt = false;
      await orderInDb.save();

      return {
        status: 200,
        success: true,
        message: "Shree Maruti NDR submission successful",
        failedOrders,
        shreeMarutiResponse: result,
      };
    }

    return {
      status: 422,
      success: false,
      error: "NDR not accepted by Shree Maruti",
      failedOrders,
      shreeMarutiResponse: result,
    };
  } catch (error) {
    console.error(
      "Shree Maruti NDR Error:",
      error?.response?.data || error.message
    );

    return {
      status: 500,
      success: false,
      error: "An error occurred while submitting NDR to Shree Maruti",
      details: error?.response?.data || error.message,
    };
  }
};

const callSmartshipNdrApi = async (
  awb_number,
  action,
  comments,
  next_attempt_date
) => {
  try {
    const token = await getAccessToken();

    // Validation
    if (!action || !comments) {
      return {
        success: false,
        error: "action and comments are required",
      };
    }

    let action_id = action === "RTO" ? 2 : 1;

    // Fetch order from DB
    const currentOrder = await Order.findOne({ awb_number });
    if (!currentOrder) {
      return {
        success: false,
        error: `Order not found for AWB: ${awb_number}`,
      };
    }

    // Prepare payload
    const requestBody = {
      orders: [
        {
          request_order_id: currentOrder.shipment_id,
          action_id: String(action_id),
          comments,
          next_attempt_date,
          address: currentOrder.receiverAddress.address || "",
          phone: currentOrder.receiverAddress.phoneNumber || "",
          names: currentOrder.receiverAddress.contactName || "",
        },
      ],
    };

    // Call Smartship API
    const smartshipResponse = await axios.post(
      "http://api.smartship.in/v2/app/Fulfillmentservice/orderReattempt",
      requestBody,
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      }
    );

    const { status, code, message } = smartshipResponse.data;

    if (status === 1) {
      // --- Build entry ---
      const entry = {
        action: action_id === 1 ? "RE-ATTEMPT" : "RTO",
        actionBy: "ShipexIndia",
        remark: comments,
        source: "ShipexIndia",
        date: new Date(),
      };

      // --- Push to nested ndrHistory ---
      if (!Array.isArray(currentOrder.ndrHistory)) {
        currentOrder.ndrHistory = [];
      }

      const latest =
        currentOrder.ndrHistory[currentOrder.ndrHistory.length - 1];
      if (latest.actions.length < 2) {
        latest.actions.push(entry);
      }

      // --- Update order status ---
      currentOrder.ndrStatus = "Action_Requested";
      currentOrder.status = "Undelivered";
      currentOrder.reattempt = false;
      await currentOrder.save();

      return {
        success: true,
        statusCode: code,
        message: "NDR submission successful",
        smartshipResponse: smartshipResponse.data,
      };
    }

    // If Smartship API didn't return success
    return {
      success: false,
      statusCode: code,
      error: message || "Smartship API request failed",
      smartshipResponse: smartshipResponse.data,
    };
  } catch (error) {
    console.error("❌ Error calling Smartship Reattempt API:", error.message);

    if (error.response) {
      return {
        success: false,
        statusCode: error.response.status,
        error: error.response.data || "Error from Smartship API",
      };
    }

    return {
      success: false,
      statusCode: 500,
      error: "Internal server error",
    };
  }
};

const submitNdrToZipypost = async (awb, payload) => {
  try {
    const {
      action,
      seller_remark,
      contact_number,
      customer_name,
      address1,
      address2,
      provider,
    } = payload;
    const token = await getAuthToken();
    const sellerId = process.env.ZIPYPOST_SELLER_ID;
    // ✅ Basic validation
    if (!awb || !action || !seller_remark) {
      return {
        status: 400,
        success: false,
        error: "Missing required fields (awb, action, or seller_remark)",
      };
    }

    // Validate specific fields based on action type
    if (action === "Change Contact" && !/^[6-9]\d{9}$/.test(contact_number)) {
      return {
        status: 400,
        success: false,
        error:
          "Valid 10-digit contact_number (starting with 6/7/8/9) is required for Change Contact action",
      };
    }

    if (
      action === "Change Address" &&
      (!customer_name || !address1 || !address2)
    ) {
      return {
        status: 400,
        success: false,
        error:
          "customer_name, address1, and address2 are required for Change Address action",
      };
    }

    // ✅ Build API URL & payload
    const url = `https://api.zipypost.com/ndr/${awb}`;
    const requestBody = {
      action,
      seller_remark,
      ...(contact_number ? { contact_number } : {}),
      ...(customer_name ? { customer_name } : {}),
      ...(address1 ? { address1 } : {}),
      ...(address2 ? { address2 } : {}),
    };

    console.log("📦 Sending NDR to ZipyPost:", requestBody);

    // ✅ Send POST request
    const response = await axios.post(url, requestBody, {
      headers: {
        "Content-Type": "application/json",
        authorization: token.authToken,
        timestamp: token.timestamp,
        sellerid: sellerId,
      },
    });

    console.log("✅ ZipyPost NDR Response:", response.data);

    // --- Update Order in DB (like submitNdrToDtdc) ---
    const orderInDb = await Order.findOne({ awb_number: awb });

    if (!orderInDb) {
      return {
        status: 404,
        success: false,
        error: "Order not found in database",
        zipyResponse: response.data,
      };
    }

    // --- Create history entry ---
    const entry = {
      action:
        action.toUpperCase() === "RE-ATTEMPT"
          ? "RE-ATTEMPT"
          : action.toUpperCase() === "RTO"
            ? "RTO"
            : action,
      actionBy: "ShipexIndia",
      remark: seller_remark || "NDR Action Requested",
      source: "ShipexIndia",
      date: new Date(),
    };

    // --- Ensure ndrHistory exists and push action ---
    if (!Array.isArray(orderInDb.ndrHistory)) {
      orderInDb.ndrHistory = [];
    }

    // If latest history exists, append action
    const latest = orderInDb.ndrHistory[orderInDb.ndrHistory.length - 1];
    if (latest && Array.isArray(latest.actions) && latest.actions.length < 2) {
      latest.actions.push(entry);
    } else {
      // Otherwise, add new ndrHistory record
      orderInDb.ndrHistory.push({ actions: [entry] });
    }

    // --- Update status fields ---
    orderInDb.ndrStatus = "Action_Requested";
    orderInDb.status = "Undelivered";
    orderInDb.reattempt = false;
    await orderInDb.save();

    console.log("✅ Order updated after ZipyPost NDR:", orderInDb.awb_number);

    // ✅ Return success response
    return {
      status: 200,
      success: true,
      message: `${provider} NDR submitted successfully`,
      zipyResponse: response.data,
    };
  } catch (error) {
    console.error("❌ ZipyPost NDR Submission Errororo:", error);

    return {
      status: error?.response?.status || 500,
      success: false,
      error:
        error?.response?.data?.error ||
        "Error occurred while submitting NDR to ZipyPost",
      details: error?.response?.data || error.message,
    };
  }
};

/**
 * ─────────────────────────────────────────────────────────
 * Ekart NDR Handler
 * ─────────────────────────────────────────────────────────
 * Ekart does not expose a direct NDR API endpoint.
 * We handle this internally:
 *  - RE-ATTEMPT / CHANGE_ADDRESS → log action in ndrHistory
 *  - RTO → trigger Ekart cancel API (same as cancel shipment)
 *
 * Payload expected:
 *  { awb_number, action, comments, new_address, new_address2,
 *    customer_name, new_phone, new_pincode }
 */
const submitNdrToEkart = async ({
  awb_number,
  action,
  comments,
  new_address,
  new_address2,
  customer_name,
  new_phone,
  new_pincode,
}) => {
  try {
    if (!awb_number || !action) {
      return {
        success: false,
        error: "Missing required fields (awb_number, action)",
      };
    }

    const orderInDb = await Order.findOne({ awb_number });
    if (!orderInDb) {
      return { success: false, error: "Order not found in DB" };
    }

    // For RTO → call Ekart cancel API
    if (action.toUpperCase() === "RTO") {
      const token = await getEkartAccessToken();
      if (!token) {
        return { success: false, error: "Failed to get Ekart access token" };
      }

      try {
        const cancelUrl = `https://app.elite.ekartlogistics.in/api/v1/package/cancel?tracking_id=${encodeURIComponent(awb_number)}`;
        const cancelRes = await axios.delete(cancelUrl, {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        });
        console.log("Ekart NDR RTO Response:", cancelRes.data);
        if (!(cancelRes.status === 200 && cancelRes.data?.status === true)) {
          return {
            success: false,
            error: cancelRes.data?.message || "Ekart RTO request failed",
          };
        }
      } catch (cancelErr) {
        console.error("Ekart RTO Error:", cancelErr.response?.data || cancelErr.message);
        return {
          success: false,
          error: cancelErr.response?.data?.message || "Ekart RTO API error",
        };
      }
    }

    // For RE-ATTEMPT / CHANGE_ADDRESS → log in ndrHistory & update address if provided
    const resolvedAction = action.toUpperCase() === "CHANGE_ADDRESS" ? "RE-ATTEMPT" : action.toUpperCase();

    const entry = {
      action: resolvedAction,
      actionBy: "ShipexIndia",
      remark: comments || "NDR Action Requested",
      source: "ShipexIndia",
      date: new Date(),
    };

    if (!Array.isArray(orderInDb.ndrHistory)) {
      orderInDb.ndrHistory = [];
    }

    const latest = orderInDb.ndrHistory[orderInDb.ndrHistory.length - 1];
    if (latest && Array.isArray(latest.actions) && latest.actions.length < 2) {
      latest.actions.push(entry);
    } else {
      orderInDb.ndrHistory.push({ actions: [entry] });
    }

    // If change address, update receiver address
    if (new_address || customer_name) {
      if (new_address) orderInDb.receiverAddress.address = new_address;
      if (new_address2) orderInDb.receiverAddress.address2 = new_address2;
      if (customer_name) orderInDb.receiverAddress.contactName = customer_name;
      if (new_phone) orderInDb.receiverAddress.phoneNumber = new_phone;
      if (new_pincode) orderInDb.receiverAddress.pinCode = new_pincode;
    }

    orderInDb.ndrStatus = resolvedAction === "RTO" ? "RTO" : "Action_Requested";
    orderInDb.status = "Undelivered";
    orderInDb.reattempt = false;
    await orderInDb.save();

    return {
      success: true,
      message: `Ekart NDR action (${resolvedAction}) recorded successfully`,
    };
  } catch (error) {
    console.error("Ekart NDR Error:", error?.message);
    return {
      success: false,
      error: "Error occurred while processing Ekart NDR",
      details: error.message,
    };
  }
};

const submitNdrToBoxdLogistics = async ({
  awb_number,
  action,
  remarks,
  action_date,
  updated_address_line1,
  updated_address_line2,
  updated_city,
  updated_state,
  updated_pincode,
  updated_mobile,
}) => {
  try {
    const BOXD_TOKEN = process.env.BOXDLOGISTICS_TOKEN;
    const BASE_URL = "https://api.boxdlogistics.com/seller/v1";
    const headers = {
      Authorization: `Token ${BOXD_TOKEN}`,
      "Content-Type": "application/json",
    };

    if (!awb_number || !action || !remarks) {
      return {
        success: false,
        error: "awb_number, action, and remarks are required",
      };
    }

    // Step 1: Fetch NDR details to get ndr_id for this AWB
    const ndrDetailsRes = await axios.get(
      `${BASE_URL}/ndr/by-awbs/?awb_numbers=${encodeURIComponent(awb_number)}`,
      { headers }
    );

    const ndrList = ndrDetailsRes.data;
    const ndrRecord = Array.isArray(ndrList) ? ndrList[0] : ndrList;
    const ndrId = ndrRecord?.id || ndrRecord?.ndr_id;

    if (!ndrId) {
      console.warn("BoxdLogistics NDR: No NDR ID found for AWB:", awb_number);
      // If no NDR found, do an internal-only log (like Ekart)
      const orderInDb = await Order.findOne({ awb_number });
      if (!orderInDb) return { success: false, error: "Order not found in DB" };
      const entry = {
        action: action.toUpperCase() === "CHANGE_ADDRESS" ? "RE-ATTEMPT" : action,
        actionBy: "ShipexIndia",
        remark: remarks || "NDR Action Requested",
        source: "ShipexIndia",
        date: new Date(),
      };
      if (!Array.isArray(orderInDb.ndrHistory)) orderInDb.ndrHistory = [];
      const latest = orderInDb.ndrHistory[orderInDb.ndrHistory.length - 1];
      if (latest && Array.isArray(latest.actions) && latest.actions.length < 2) {
        latest.actions.push(entry);
      } else {
        orderInDb.ndrHistory.push({ actions: [entry] });
      }
      orderInDb.ndrStatus = "Action_Requested";
      orderInDb.reattempt = false;
      await orderInDb.save();
      return { success: true, message: "NDR action logged internally (no NDR ID from BoxdLogistics)" };
    }

    // Step 2: Map action to BoxdLogistics endpoint path
    // BoxdLogistics endpoint: POST /seller/v1/ndr-action/{action_type}/
    // action_type options: reattempt, rto, update-address, update-mobile
    let endpoint;
    const actionUpper = action.toUpperCase();
    if (actionUpper === "RTO") {
      endpoint = `${BASE_URL}/ndr-action/rto/`;
    } else if (actionUpper === "CHANGE_ADDRESS") {
      endpoint = `${BASE_URL}/ndr-action/update-address/`;
    } else {
      // RE-ATTEMPT
      endpoint = `${BASE_URL}/ndr-action/reattempt/`;
    }

    const todayDate = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
    const payload = {
      ndr_id: ndrId,
      remarks,
      action_date: action_date || todayDate,
      action_by: "seller",
      ...(updated_mobile ? { updated_mobile } : {}),
      ...(actionUpper === "CHANGE_ADDRESS"
        ? {
          updated_address_line1: updated_address_line1 || "",
          updated_address_line2: updated_address_line2 || "",
          updated_city: updated_city || "",
          updated_state: updated_state || "",
          updated_pincode: updated_pincode || "",
        }
        : {}),
    };

    console.log("📦 BoxdLogistics NDR Payload:", endpoint, payload);
    const response = await axios.post(endpoint, payload, { headers });
    console.log("✅ BoxdLogistics NDR Response:", response.data);

    // Step 3: Update order in DB
    const orderInDb = await Order.findOne({ awb_number });
    if (!orderInDb) {
      return { success: true, message: "NDR submitted but order not found in DB", data: response.data };
    }

    const entry = {
      action: actionUpper === "CHANGE_ADDRESS" ? "RE-ATTEMPT" : action,
      actionBy: "ShipexIndia",
      remark: remarks,
      source: "ShipexIndia",
      date: new Date(),
    };

    if (!Array.isArray(orderInDb.ndrHistory)) orderInDb.ndrHistory = [];
    const latest = orderInDb.ndrHistory[orderInDb.ndrHistory.length - 1];
    if (latest && Array.isArray(latest.actions) && latest.actions.length < 2) {
      latest.actions.push(entry);
    } else {
      orderInDb.ndrHistory.push({ actions: [entry] });
    }

    // If Change Address — also update the receiver address
    if (actionUpper === "CHANGE_ADDRESS") {
      if (updated_address_line1) orderInDb.receiverAddress.address = updated_address_line1;
      if (updated_city) orderInDb.receiverAddress.city = updated_city;
      if (updated_state) orderInDb.receiverAddress.state = updated_state;
      if (updated_pincode) orderInDb.receiverAddress.pinCode = updated_pincode;
      if (updated_mobile) orderInDb.receiverAddress.phoneNumber = updated_mobile;
    }

    orderInDb.ndrStatus = actionUpper === "RTO" ? "RTO" : "Action_Requested";
    orderInDb.status = "Undelivered";
    orderInDb.reattempt = false;
    await orderInDb.save();

    return {
      success: true,
      message: "BoxdLogistics NDR action submitted successfully",
      data: response.data,
    };
  } catch (error) {
    console.error("❌ BoxdLogistics NDR Error:", error?.response?.data || error.message);
    return {
      success: false,
      error: "Error occurred while submitting NDR to BoxdLogistics",
      details: error?.response?.data || error.message,
    };
  }
};

module.exports = {
  getOrderDetails,
  callShiprocketNdrApi,
  callNimbustNdrApi,
  callEcomExpressNdrApi,
  handleDelhiveryNdrAction,
  submitNdrToDtdc,
  submitNdrToAmazon,
  callSmartshipNdrApi,
  submitNdrToZipypost,
  submitNdrToShreeMaruti,
  submitNdrToEkart,
  submitNdrToBoxdLogistics,
};
