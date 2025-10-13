const axios = require("axios");
require("dotenv").config();
const { getAccessToken } = require("../Authorize/smartShip.controller");
const Order = require("../../../models/newOrder.model");
const { getZone } = require("../../../Rate/zoneManagementController");
const Wallet = require("../../../models/wallet");
const User = require("../../../models/User.model");
const PickupAddress = require("../../../models/pickupAddress.model");

const registerSmartshipHub = async (userId, pinCode) => {
  try {
    const pickupAddress = await PickupAddress.findOne({
      userId,
      "pickupAddress.pinCode": pinCode,
    });
    // console.log("pickup", pickupAddress);
    if (!pickupAddress) {
      return {
        success: false,
      };
    }

    if (pickupAddress.smartshipHubId) {
      // console.log("✅ Smartship Hub already registered:", pickupAddress.smartshipHubId);
      return {
        // success: true,
        hubId: pickupAddress.smartshipHubId,
        // message: "Smartship Hub already registered for this pincode",
      };
    }

    const { pickupAddress: addr } = pickupAddress;

    const hubPayload = {
      hub_details: {
        hub_name: addr.contactName || "Warehouse",
        pincode: addr.pinCode,
        city: addr.city,
        state: addr.state,
        address1: addr.address,
        hub_phone: addr.phoneNumber,
        delivery_type_id: 2,
      },
    };
    // console.log(hubPayload);
    const accessToken = await getAccessToken();

    const response = await axios.post(
      "https://api.smartship.in/v2/app/Fulfillmentservice/hubRegistration",
      hubPayload,
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    const hubId = response?.data?.data?.hub_id;

    if (!hubId) {
      throw new Error("Smartship Hub ID not returned");
    }

    pickupAddress.smartshipHubId = hubId;
    await pickupAddress.save();

    // console.log("✅ Smartship Hub registered and saved:", hubId);

    return {
      // success: true,
      hubId,
      // message: "Smartship Hub registered successfully",
    };
  } catch (err) {
    console.error("❌ Hub Registration Failed:", err.message || err);
    return {
      success: false,
      error: err.message || err,
    };
  }
};

const orderRegistrationOneStep = async (req, res) => {
  try {
    const { id, finalCharges, courierServiceName, provider,estimatedDeliveryDate } = req.body;
    console.log("req.body", req.body);
    const accessToken = await getAccessToken();
    const currentOrder = await Order.findById(id);
    if (!currentOrder) {
      return res
        .status(404)
        .json({ success: false, message: "Order not found" });
    }
    const zone = await getZone(
      currentOrder.pickupAddress.pinCode,
      currentOrder.receiverAddress.pinCode
      // res
    );
    // console.log("zone", zone);
    if (!zone) {
      return res.status(400).json({ message: "Pincode not serviceable" });
    }
    const user = await User.findById(currentOrder.userId);
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    const smartshipHub = await registerSmartshipHub(
      user._id,
      currentOrder.pickupAddress.pinCode
    );
    // console.log("Smartship Hub:", smartshipHub);
    if (smartshipHub.success === false) {
      return res.status(400).json({
        success: false,
        message:
          "Pickup pincode is not registered. Please add a pickup address first.",
      });
    }

    const currentWallet = await Wallet.findById(user.Wallet);
    if (!currentWallet) {
      return res
        .status(404)
        .json({ success: false, message: "Wallet not found" });
    }

    const effectiveBalance =
      currentWallet.balance - (currentWallet.holdAmount || 0);
    if (currentWallet.balance < finalCharges) {
      return res
        .status(400)
        .json({ success: false, message: "Insufficient Wallet Balance" });
    }

    const productNames = currentOrder.productDetails
      .map((p) => p.name)
      .join(", ");

    const payload = {
      request_info: {
        client_id: "", // Optional
        run_type: "create",
      },
      orders: [
        {
          client_order_reference_id: currentOrder.orderId,
          shipment_type: 1,
          order_collectable_amount:
            currentOrder.paymentDetails.method === "COD"
              ? currentOrder.paymentDetails.amount
              : 0,
          total_order_value: currentOrder.paymentDetails.amount.toString(),
          payment_type: currentOrder.paymentDetails.method.toLowerCase(), // cod or prepaid
          package_order_weight: (
            currentOrder.packageDetails.applicableWeight * 1000
          ).toString(), // in grams
          package_order_length:
            currentOrder.packageDetails.volumetricWeight.length.toString(),
          package_order_height:
            currentOrder.packageDetails.volumetricWeight.height.toString(),
          package_order_width:
            currentOrder.packageDetails.volumetricWeight.width.toString(),
          shipper_hub_id: smartshipHub.hubId || "",
          shipper_gst_no: "",
          order_invoice_date: new Date().toISOString().slice(0, 10), // today's date (or you can pull from order)
          order_invoice_number: `INV-${currentOrder.orderId}-${Date.now()}`, // optional
          is_return_qc: "0",
          return_reason_id: "0",
          order_meta: {
            preferred_carriers: [279], // use given courier
          },
          product_details: currentOrder.productDetails.map((product) => ({
            client_product_reference_id: product._id.toString(),
            product_name: product.name,
            product_category: product.category || "General",
            product_hsn_code: product.hsn || "0000",
            product_quantity: product.quantity || 1,
            product_gst_tax_rate: product.gst || "0",
            product_invoice_value: product.unitPrice.toString(),
          })),
          consignee_details: {
            consignee_name: currentOrder.receiverAddress.contactName,
            consignee_phone: currentOrder.receiverAddress.phoneNumber,
            consignee_email:
              currentOrder.receiverAddress.email || "noemail@example.com",
            consignee_complete_address: currentOrder.receiverAddress.address,
            consignee_pincode: currentOrder.receiverAddress.pinCode,
          },
        },
      ],
    };

    const response = await axios.post(
      "https://api.smartship.in/v2/app/Fulfillmentservice/orderRegistrationOneStep",
      payload,
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );
    console.log("Smartship Order Response:", response.data);
    // console.log(
    //   "Smartship Order Response:",
    //   response.data.data.errors.data_discrepancy
    // );

    if (response.data.data.errors) {
      return res.status(400).json({
        success: false,
        message: "Error creating Shipment",
      });
    }

    // Duplicate order check
    const respData = response.data?.data;
    if (
      (!respData?.success_order_details ||
        !respData.success_order_details.orders ||
        respData.success_order_details.orders.length === 0) &&
      respData?.duplicate_orders
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Duplicate orderId is not allowed in courier Bluedart, ship with another courier",
        errors: respData.errors,
        duplicate_orders: respData.duplicate_orders,
      });
    }
    // Save AWB and update order status
    const result = response.data?.data?.success_order_details?.orders?.[0];

    if (result?.awb_number) {
      currentOrder.status = "Booked";
      currentOrder.awb_number = result.awb_number;
      currentOrder.shipment_id = result.request_order_id || "";
      currentOrder.provider = provider;
      currentOrder.totalFreightCharges = parseInt(finalCharges);
      currentOrder.courierServiceName = courierServiceName;
      currentOrder.shipmentCreatedAt = new Date();
      currentOrder.zone = zone.zone;
      currentOrder.estimatedDeliveryDate=estimatedDeliveryDate;
      currentOrder.tracking.push({
        status: "Booked",
        StatusLocation: currentOrder.pickupAddress?.city || "N/A",
        StatusDateTime: new Date(),
        Instructions: "Order booked successfully",
      });
      await currentOrder.save();

      await currentWallet.updateOne({
        $inc: { balance: -parseInt(finalCharges) },
        $push: {
          transactions: {
            channelOrderId: currentOrder.orderId,
            category: "debit",
            amount: parseInt(finalCharges),
            balanceAfterTransaction: effectiveBalance - parseInt(finalCharges),
            date: new Date(),
            awb_number: result.awb_number,
            description: `Freight Charges Applied`,
          },
        },
      });
    }

    return res.status(200).json({
      message: "Shipment Created Successfully",
      success: true,
      data: response.data,
    });
  } catch (error) {
    console.error(
      "Smartship Order Registration Error:",
      error?.response?.data || error.message
    );
    return res.status(500).json({
      success: false,
      message: "Failed to register order",
      error: error?.response?.data || error.message,
    });
  }
};

const checkSmartshipHubServiceability = async (payload) => {
  try {
    const accessToken = await getAccessToken();

    const requestBody = {
      order_info: {
        source_pincode: payload.source_pincode,
        destination_pincode: payload.destination_pincode,
        order_weight: payload.order_weight || 0.5,
        order_value: payload.order_value || 100,
        preferred_carriers: [1, 3, 279],
        delivery_type: 1,
      },
      request_info: {
        extra_info: false,
        cost_info: false,
      },
    };

    const response = await axios.post(
      "https://api.smartship.in/v2/app/Fulfillmentservice/ServiceabilityHubWise",
      requestBody,
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    // console.log("Smartship Serviceability Response:", response.data);

    const serviceabilityData = response.data?.data;
    const serviceable = serviceabilityData?.serviceability_status === true;

    return {
      success: serviceable,
      data: serviceabilityData || {},
    };
  } catch (err) {
    // console.error(
    //   "Smartship Serviceability Error:",
    //   err.response?.data || err.message
    // );
    return {
      success: false,
      error: err.response?.data || err.message,
    };
  }
};

const cancelSmartshipOrder = async (client_order_reference_id) => {
  try {
    if (!client_order_reference_id) {
      return {
        success: false,
        message: "client_order_reference_id is required",
      };
    }

    const isCancelled = await Order.findOne({
      orderId: client_order_reference_id,
      status: "Cancelled",
    });

    if (isCancelled) {
      return {
        // success: false,
        code: 400,
        error: "Order is already cancelled",
      };
    }

    const accessToken = await getAccessToken();

    const requestPayload = {
      request_info: {
        ip_address: "14.142.227.166",
        browser_name: "Mozilla",
        location: "Delhi",
      },
      orders: {
        client_order_reference_ids: [client_order_reference_id],
        request_order_ids: [],
      },
    };

    const response = await axios.post(
      "https://api.smartship.in/v2/app/Fulfillmentservice/orderCancellation",
      requestPayload,
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    const cancellationDetails =
      response?.data?.data?.order_cancellation_details;

    if (cancellationDetails?.successful) {
      await Order.updateOne(
        { orderId: client_order_reference_id },
        { $set: { status: "Cancelled" } }
      );

      return {
        // error: true,
        code: 201,
        data: cancellationDetails.successful,
      };
    } else {
      console.error(
        "Smartship Cancellation Error:",
        cancellationDetails?.failure || "Unknown error"
      );
      return {
        code: 400,
        error: true,
        success:false,
        message: "Failed to cancel order",
        details: cancellationDetails?.failure || {},
      };
    }
  } catch (error) {
    console.error(
      "Smartship Cancel Order Error:",
      error?.response?.data || error.message
    );
    return {
      error: true,
      message: "Failed to cancel order",
      error: error?.response?.data || error.message,
    };
  }
};

// cancelSmartshipOrder(342276)

const trackOrderSmartShip = async (AWBNo, shipment_id) => {
  const access_key = await getAccessToken();
  // console.log(access_key);

  try {
    const response = await axios.post(
      `https://api.smartship.in/v1/Trackorder?tracking_numbers=${AWBNo}`,
      {}, // <-- empty body
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${access_key}`,
        },
      }
    );

    // console.log("response data", response.data);
    console.log("respose status",response.data.data.scans)
    // console.log("response status", response.data.data.scans["20726635"][0].call_logs);
    if (response.data.message === "success") {
      const trackingData=response.data.data.scans
      const request_order_id=Object.keys(trackingData || {})[0];
      const trackingArray=trackingData?.[request_order_id];
      return { success: true, data: trackingArray };
    }
  } catch (error) {
    console.error(
      "Error tracking shipment:",
      error.response?.data || error.message
    );
    return {
      success: false,
      error: error.response?.data || error.message,
      status: 500,
    };
  }
};

// trackOrderSmartShip("SMPC0000303506")

module.exports = {
  orderRegistrationOneStep,
  checkSmartshipHubServiceability,
  cancelSmartshipOrder,
  trackOrderSmartShip,
  registerSmartshipHub,
};
