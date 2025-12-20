const Order = require("../../../../../../models/newOrder.model");
const BASE_URL = process.env.B2B_SHIPROCKET_URL;
const { refreshToken } = require("../Authorize/shiprocket.controller");
const axios = require("axios");

exports.createShiprocketCargoShipment = async (req, res) => {
  try {
    const { orderId } = req.body;

    const order = await Order.findOne({ orderId });
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    if (order.orderType !== "B2B") {
      return res
        .status(400)
        .json({ message: "Shiprocket Cargo supports B2B only" });
    }

    const token = await getShiprocketCargoToken();

    /* ================================
       STEP 1: ORDER CREATION
    ================================= */

    const packaging_unit_details = order.B2BPackageDetails.packages.map(
      (pkg) => ({
        units: pkg.noOfBox,
        weight: pkg.weightPerBox,
        length: pkg.length,
        width: pkg.width,
        height: pkg.height,
      })
    );

    const no_of_packages = packaging_unit_details.reduce(
      (sum, p) => sum + p.units,
      0
    );

    const orderPayload = {
      no_of_packages,
      invoice_value: order.paymentDetails.amount,
      approx_weight: order.B2BPackageDetails.applicableWeight,
      is_insured: false,
      is_to_pay: false,
      source_warehouse_name: order.pickupAddress.contactName,
      source_address_line1: order.pickupAddress.address,
      source_address_line2: "",
      source_pincode: order.pickupAddress.pinCode,
      source_city: order.pickupAddress.city,
      source_state: order.pickupAddress.state,
      sender_contact_person_name: order.pickupAddress.contactName,
      sender_contact_person_email: order.pickupAddress.email,
      sender_contact_person_contact_no: order.pickupAddress.phoneNumber,

      destination_warehouse_name: order.receiverAddress.contactName,
      destination_address_line1: order.receiverAddress.address,
      destination_address_line2: "",
      destination_pincode: order.receiverAddress.pinCode,
      destination_city: order.receiverAddress.city,
      destination_state: order.receiverAddress.state,
      recipient_contact_person_name: order.receiverAddress.contactName,
      recipient_contact_person_email: order.receiverAddress.email,
      recipient_contact_person_contact_no: order.receiverAddress.phoneNumber,

      client_id: Number(process.env.SHIPROCKET_CARGO_CLIENT_ID),
      packaging_unit_details,

      is_cod: order.paymentDetails.method === "COD",
      cod_amount:
        order.paymentDetails.method === "COD"
          ? order.paymentDetails.amount
          : null,

      mode_name: "surface",
      source: "API",
    };

    const orderRes = await axios.post(
      `${process.env.SHIPROCKET_CARGO_BASE_URL}/api/external/order_creation/`,
      orderPayload,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    const { order_id, mode_id, delivery_partner_id, transportar_id } =
      orderRes.data;

    /* ================================
       STEP 2: SHIPMENT CREATION (ASYNC)
    ================================= */

    if (order.paymentDetails.amount > 50000 && !order.otherDetails?.ewaybill) {
      return res.status(400).json({
        message: "E-way bill is mandatory for invoice value above 50,000",
      });
    }

    const shipmentPayload = {
      client_id: Number(process.env.SHIPROCKET_CARGO_CLIENT_ID),
      order_id,
      remarks: "Shipment booked via API",
      recipient_GST: order.otherDetails?.gstin || null,
      to_pay_amount: "0",
      mode_id,
      delivery_partner_id,
      pickup_date_time: new Date().toISOString().slice(0, 19).replace("T", " "),
      eway_bill_no: order.otherDetails?.ewaybill || null,
      invoice_value: order.paymentDetails.amount,
      invoice_number: order.compositeOrderId,
      invoice_date: new Date().toISOString().split("T")[0],
      source: "API",
    };

    const shipmentRes = await axios.post(
      `${process.env.SHIPROCKET_CARGO_BASE_URL}/api/order_shipment_association/`,
      shipmentPayload,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    /* ================================
       STEP 3: SAVE DB (ASYNC FLOW)
    ================================= */

    order.shipment_id = shipmentRes.data.id;
    order.provider = "shiprocket_cargo";
    order.partner = shipmentRes.data.delivery_partner?.name;
    order.courierServiceName = shipmentRes.data.delivery_partner?.common_name;
    order.shipmentCreatedAt = new Date();
    order.status = "Shipment Created";

    await order.save();

    return res.json({
      success: true,
      message: "Shipment created successfully (Async)",
      shipment_id: shipmentRes.data.id,
      shiprocket_order_id: order_id,
    });
  } catch (error) {
    console.error("Shiprocket Cargo Error:", error?.response?.data || error);
    return res.status(500).json({
      success: false,
      message: "Shiprocket Cargo shipment creation failed",
      error: error?.response?.data || error.message,
    });
  }
};

exports.getShiprocketCargoShipmentDetailsInternal = async (shipmentId) => {
  const order = await Order.findOne({ shipment_id: shipmentId });
  if (!order) return;

  if (order.awb_number && order.label) return;

  const token = await getShiprocketCargoToken();

  const { data } = await axios.get(
    `${process.env.SHIPROCKET_CARGO_BASE_URL}/api/external/get_shipment/${shipmentId}/`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }
  );

  if (!data || !data.waybill_no) {
    throw new Error("Shipment not ready yet");
  }

  order.awb_number = data.waybill_no;
  order.label = data.label_url || order.label;
  order.child_awb_numbers = [
    ...new Set([
      ...(order.child_awb_numbers || []),
      ...(data.child_waybill_nos || []),
    ]),
  ];

  order.courierServiceName = data.delivery_partner?.common_name;
  order.partner = data.delivery_partner?.name;
  order.status = data.status;

  const awbTrackingExists = order.tracking.some(
    (t) => t.status === "AWB Generated"
  );

  if (!awbTrackingExists) {
    order.tracking.push({
      status: "AWB Generated",
      StatusLocation: order.pickupAddress.city,
      StatusDateTime: new Date(),
      Instructions: "AWB auto-fetched via async job",
    });
  }
  await order.save();
};

const getCargoShipmentCharges = async () => {
  try {
    const accessToken = await refreshToken();
    if (!accessToken) {
      throw new Error("Shiprocket Cargo access token missing");
    }

    const payload = {
      from_pincode: "122001",
      from_city: "Gurgaon",
      from_state: "Haryana",
      to_pincode: "400001",
      to_city: "Mumbai",
      to_state: "Maharashtra",
      quantity: 2,
      invoice_value: 1111,
      calculator_page: "true",
      packaging_unit_details: [
        {
          units: 2,
          length: 11,
          height: 11,
          weight: 12,
          width: 11,
          unit: "cm",
        },
      ],
    };

    const response = await axios.post(
      `${BASE_URL}/api/shipment/charges/`,
      payload,
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    console.log("✅ Shiprocket Cargo Charges Response:");
    console.log(response.data);
  } catch (error) {
    console.error("❌ Shiprocket Cargo Charges Error:");
    console.error(error?.response?.data || error.message);
  }
};

// getCargoShipmentCharges();
