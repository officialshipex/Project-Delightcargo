const { getAmazonAccessToken } = require("../Authorize/saveCourierController");
const axios = require("axios");
const Order = require("../../../models/newOrder.model");
const Wallet = require("../../../models/wallet");
const User = require("../../../models/User.model");
const { s3 } = require("../../../config/s3");
const { getZone } = require("../../../Rate/zoneManagementController");
const { PutObjectCommand } = require("@aws-sdk/client-s3");
const {
  markWooOrderAsSihpped,
} = require("../../../Channels/WooCommerce/woocommerce.controller");

const createOneClickShipment = async (req, res) => {
  try {
    const accessToken = await getAmazonAccessToken();
    if (!accessToken) {
      return res.status(401).json({ error: "Access token missing" });
    }
    // console.log(req.body)
    const {
      id,
      provider,
      finalCharges,
      courierServiceName,
      estimatedDeliveryDate,
    } = req.body;
    const currentOrder = await Order.findById(id);
    if (!currentOrder) {
      return res.status(404).json({ message: "Order not found" });
    }

    if (currentOrder.status !== "new") {
      return res.status(400).json({
        success: false,
        message: `Shipment cannot be created because order status is '${currentOrder.status}'.`,
      });
    }

    const zone = await getZone(
      currentOrder.pickupAddress.pinCode,
      currentOrder.receiverAddress.pinCode
      // res
    );
    if (!zone) {
      return res.status(400).json({ message: "Pincode not serviceable" });
    }
    const user = await User.findById(currentOrder.userId);
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }
    const currentWallet = await Wallet.findById(user.Wallet);
    if (!currentWallet) {
      return res.status(404).json({ message: "Wallet not found" });
    }

    const weight = currentOrder.packageDetails?.applicableWeight * 1000;
    const payload = {
      origin: currentOrder.pickupAddress,
      destination: currentOrder.receiverAddress,
      payment_type: currentOrder.paymentDetails?.method,
      order_amount: currentOrder.paymentDetails?.amount || 0,
      weight: weight || 0,
      length: currentOrder.packageDetails.volumetricWeight?.length || 0,
      breadth: currentOrder.packageDetails.volumetricWeight?.width || 0,
      height: currentOrder.packageDetails.volumetricWeight?.height || 0,
      productDetails: currentOrder.productDetails,
      orderId: currentOrder.orderId,
    };
    const { rate, requestToken, valueAddedServiceIds } =
      await checkAmazonServiceability("Amazon", payload);

    console.log("Extracted VAS IDs from rate:", valueAddedServiceIds);

    // const { id, requestToken, rateId } = req.body;

    const isCOD = payload.payment_type === "COD";

    const shipmentData = {
      requestToken,
      rateId: rate,
      requestedDocumentSpecification: {
        format: "PDF",
        size: {
          width: 4.0,
          length: 6.0,
          unit: "INCH",
        },
        dpi: 300,
        pageLayout: "DEFAULT",
        needFileJoining: false,
        requestedDocumentTypes: ["LABEL"],
      },
      // Use requestedValueAddedServices
      requestedValueAddedServices: [
        ...(isCOD ? [{ id: "CollectOnDelivery" }] : []),
      ],
    };

    // console.log("shipment data", shipmentData);
    let response;
    const walletHoldAmount = currentWallet?.holdAmount || 0;
    const effectiveBalance = currentWallet.balance - walletHoldAmount;
    if (currentWallet.balance >= finalCharges) {
      response = await axios.post(
        "https://sellingpartnerapi-eu.amazon.com/shipping/v2/shipments",
        shipmentData,
        {
          headers: {
            // Authorization: `Bearer ${accessToken}`,
            "x-amz-access-token": accessToken,
            "x-amzn-shipping-business-id": "AmazonShipping_IN",
            "Content-Type": "application/json",
          },
        }
      );
    } else {
      return res
        .status(400)
        .json({ success: false, message: "Insufficient Wallet Balance" });
    }

    if (response?.data?.payload) {
      const result = response.data.payload;
      const base64Label =
        result.packageDocumentDetails[0].packageDocuments[0].contents;
      const labelBuffer = Buffer.from(base64Label, "base64");
      const labelKey = `labels/${Date.now()}_${
        currentOrder.orderId || "label"
      }.pdf`;

      const uploadCommand = new PutObjectCommand({
        Bucket: process.env.AWS_BUCKET_NAME,
        Key: labelKey,
        Body: labelBuffer,
        ContentType: "application/pdf",
      });

      await s3.send(uploadCommand);

      const labelUrl = `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${labelKey}`;

      currentOrder.status = "Booked";
      currentOrder.cancelledAtStage = null;
      currentOrder.awb_number = result.packageDocumentDetails[0].trackingId;
      currentOrder.shipment_id = `${result.shipmentId}`;
      currentOrder.provider = provider;
      currentOrder.totalFreightCharges =
        finalCharges === "N/A" ? 0 : parseInt(finalCharges);
      currentOrder.courierServiceName = courierServiceName;
      currentOrder.shipmentCreatedAt = new Date();
      currentOrder.label = labelUrl;
      currentOrder.zone = zone.zone;
      currentOrder.estimatedDeliveryDate = estimatedDeliveryDate;
      currentOrder.tracking.push({
        status: "Booked",
        StatusLocation: currentOrder.pickupAddress?.city || "N/A",
        StatusDateTime: new Date(),
        Instructions: "Order booked successfully",
      });
      let savedOrder = await currentOrder.save();
      let balanceToBeDeducted =
        finalCharges === "N/A" ? 0 : parseInt(finalCharges);
      await currentWallet.updateOne({
        $inc: { balance: -balanceToBeDeducted },
        $push: {
          transactions: {
            channelOrderId: currentOrder.orderId || null,
            category: "debit",
            amount: balanceToBeDeducted,
            balanceAfterTransaction:
              currentWallet.balance - balanceToBeDeducted,
            date: new Date(),
            awb_number: result.packageDocumentDetails[0].trackingId || "",
            description: "Freight Charges Applied",
          },
        },
      });
      // if (currentOrder.channel?.toLowerCase() === "woocommerce") {
      //   await markWooOrderAsSihpped(
      //     currentOrder.storeUrl,
      //     currentOrder.channelId,
      //     currentOrder.awb_number,
      //     currentOrder.provider
      //   );
      // }
    } else {
      console.log("eror", response.data);
      return res.status(400).json({ message: "Error creating shipment" });
    }

    console.log("✅ Shipment Created:", response.data);
    return res.status(200).json({
      success: true,
      message: "Shipment Created Successfully",
      shipment: response.data,
    });
  } catch (error) {
    console.error(
      "❌ Error creating shipment:",
      error.response?.data || error.message
    );
    return res.status(500).json({
      success: false,
      error: "Error creating shipment",
      details: error.response?.data || error.message,
    });
  }
};

const cancelShipment = async (shipmentId) => {
  const accessToken = await getAmazonAccessToken();
  // console.log("accessToken",accessToken)
  if (!accessToken) {
    // console.error("Failed to get access token");
    return;
  }

  const isCancelled = await Order.findOne({
    shipment_id: shipmentId,
    status: "Cancelled",
  });
  if (isCancelled) {
    console.log("order is allready cancelled");
    return {
      success: false,
      error: "Order is allready cancelled",
      code: 400,
    };
  }

  try {
    const response = await axios.put(
      `https://sellingpartnerapi-eu.amazon.com/shipping/v2/shipments/${shipmentId}/cancel`,
      {},
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "x-amz-access-token": accessToken,
          "x-amzn-shipping-business-id": "AmazonShipping_IN",
          "Content-Type": "application/json",
        },
      }
    );

    await Order.updateOne(
      { shipment_id: shipmentId },
      { $set: { status: "Cancelled" } }
    );

    if (response.data.payload) {
      console.log("Shipment Cancelled Successfully", response);
      return {
        data: response.data,
        code: 201,
      };
    } else {
      return {
        error: "Error in shipment cancellation",
        details: response.data,
        code: 400,
        success: false,
      };
    }

    // return response.data; // Amazon returns an empty object on success
  } catch (error) {
    console.error(
      "Error cancelling shipment:",
      error.response?.data || error.message
    );
    return {
      success: false,
      message: "Failed to cancel shipment",
      error: error.response?.data,
    };
  }
};

// cancelShipment(121212)

const getShipmentTracking = async (trackingId) => {
  const accessToken = await getAmazonAccessToken();
  if (!accessToken) {
    // console.error("Failed to get access token");
    return;
  }

  try {
    const response = await axios.get(
      "https://sellingpartnerapi-eu.amazon.com/shipping/v2/tracking",
      {
        params: { trackingId: trackingId, carrierId: "ATS" },
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "x-amz-access-token": accessToken,
          "x-amzn-shipping-business-id": "AmazonShipping_IN",
        },
      }
    );
    console.log("response", response.data.payload);
    // console.log(
    //   "Tracking Information:",
    //   response.data.payload.eventHistory[
    //     response.data.payload.eventHistory.length - 4
    //   ]
    // );
    const remarkData = response.data.payload.summary?.trackingDetailCodes;
    let remark;
    if (
      response.data.payload.eventHistory[
        response.data.payload.eventHistory.length - 1
      ].shipmentType === "FORWARD"
    ) {
      remark = remarkData?.forward?.[0];
    } else {
      remark = remarkData?.reverse[1];
    }
    return { success: true, data: response.data.payload.eventHistory, remark };
  } catch (error) {
    console.error(
      "Error fetching tracking information:",
      error.response?.data || error.message
    );
  }
};
// getShipmentTracking("364157621588");

const checkAmazonServiceability = async (provider, payload) => {
  try {
    // console.log("payloadprovider", payload);

    const accessToken = await getAmazonAccessToken();
    if (!accessToken) return { success: false, reason: "Missing access token" };

    const shipFrom = {
      name: payload.origin.contactName,
      addressLine1: payload.origin.address.slice(0, 60),
      city: payload.origin.city,
      postalCode: payload.origin.pinCode,
      countryCode: "IN",
      email: payload.origin.email,
      phoneNumber: payload.origin.phoneNumber,
    };

    const shipTo = {
      name: payload.destination.contactName,
      addressLine1: payload.destination.address.slice(0, 60),
      city: payload.destination.city,
      postalCode: payload.destination.pinCode,
      countryCode: "IN",
      email: payload.destination.email,
      phoneNumber: payload.destination.phoneNumber,
    };
    const totalQuantity = payload.productDetails.reduce(
      (sum, item) => sum + item.quantity,
      0
    );
    const weightPerUnit = Math.floor(payload.weight / totalQuantity); // in grams
    const requestBody = {
      shipFrom,
      shipTo,
      shipDate: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      packages: [
        {
          dimensions: {
            length: payload.length,
            width: payload.breadth,
            height: payload.height,
            unit: "CENTIMETER",
          },
          weight: {
            value: payload.weight / 1000, // Convert grams to kg
            unit: "KILOGRAM",
          },
          insuredValue: {
            value: payload.order_amount,
            unit: "INR",
          },
          packageClientReferenceId: `${payload.orderId}`,
          items: payload.productDetails.map((item) => ({
            itemValue: {
              value: Number(item.unitPrice),
              unit: "INR",
            },
            quantity: item.quantity,
            weight: {
              unit: "GRAM",
              value: weightPerUnit,
            },
            isHazmat: false,
            invoiceDetails: {
              invoiceDate: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
            },
          })),
        },
      ],
      taxDetails: [
        {
          taxType: "GST",
          taxRegistrationNumber: "06FKCPS6109D3Z7",
        },
      ],
      channelDetails: {
        channelType: "EXTERNAL",
      },
      ...(payload.payment_type === "COD" && {
        valueAddedServices: {
          collectOnDelivery: {
            amount: {
              value: payload.order_amount,
              unit: "INR",
            },
          },
        },
      }),
    };

    // console.log(
    //   "body",
    //   requestBody.packages[0].items,
    //   requestBody.packages[0].weight
    // );

    const response = await axios.post(
      "https://sellingpartnerapi-eu.amazon.com/shipping/v2/shipments/rates",
      requestBody,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "x-amz-access-token": accessToken,
          "x-amzn-shipping-business-id": "AmazonShipping_IN",
          "Content-Type": "application/json",
        },
      }
    );

    const rates = response.data.payload.rates || [];
    const ineligibleRates = response.data.payload.ineligibleRates || [];
    // console.log("reat", response.data.payload);

    if (rates.length > 0) {
      const selectedRate = rates[0]; // Use the first rate (or allow user to pick one)

      const valueAddedServiceIds =
        selectedRate.availableValueAddedServiceGroups?.flatMap((group) => {
          // Some APIs return valueAddedServices instead of valueAddedServiceIds
          if (group.valueAddedServiceIds) return group.valueAddedServiceIds;
          if (group.valueAddedServices)
            return group.valueAddedServices.map((vas) => vas.id);
          return [];
        }) || [];

      // console.log("val", valueAddedServiceIds);

      return {
        success: true,
        reason: "Pincodes are serviceable",
        rate: selectedRate.rateId,
        serviceable: true,
        requestToken: response.data.payload.requestToken,
        valueAddedServiceIds, // ✅ include this in return
      };
    } else if (ineligibleRates.length > 0) {
      // console.log("❌ Amazon does not service this pincode.");
      return {
        success: false,
        reason: "Pincodes are not serviceable",
        ineligibleRates,
      };
    } else {
      return { success: false, reason: "No rates returned by Amazon" };
    }
  } catch (error) {
    // console.error(
    //   "Error checking serviceabilityyy:",
    //   error.response?.data || error.message
    // );
    return { success: false, reason: "Error checking serviceability" };
  }
};

module.exports = {
  createOneClickShipment,
  cancelShipment,
  getShipmentTracking,
  checkAmazonServiceability,
};
