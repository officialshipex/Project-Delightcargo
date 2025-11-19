const { getAmazonAccessToken } = require("../Authorize/saveCourierController");
const axios = require("axios");
const mongoose = require("mongoose");
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
  const session = await mongoose.startSession();

  try {
    session.startTransaction();

    const accessTokenPromise = getAmazonAccessToken(); // Run early in parallel

    const {
      id,
      provider,
      finalCharges,
      courierServiceName,
      estimatedDeliveryDate,
    } = req.body;

    // Step 1️⃣ Fetch order and lock it
    const currentOrder = await Order.findOneAndUpdate(
      { _id: id, status: "new" },
      { $set: { status: "processing" } },
      { new: true, session }
    );

    if (!currentOrder) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: `Shipment cannot be created because order is already processed or not in 'new' status.`,
      });
    }

    // Step 2️⃣ Parallel async calls
    const [accessToken, zone, user] = await Promise.all([
      accessTokenPromise,
      getZone(
        currentOrder.pickupAddress.pinCode,
        currentOrder.receiverAddress.pinCode
      ),
      User.findById(currentOrder.userId).session(session),
    ]);

    if (!accessToken) {
      await Order.findByIdAndUpdate(id, { status: "new" }, { session });
      await session.abortTransaction();
      session.endSession();
      return res.status(401).json({ error: "Access token missing" });
    }

    if (!zone) {
      await Order.findByIdAndUpdate(id, { status: "new" }, { session });
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: "Pincode not serviceable" });
    }

    if (!user) {
      await Order.findByIdAndUpdate(id, { status: "new" }, { session });
      await session.abortTransaction();
      session.endSession();
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    // Step 3️⃣ Fetch wallet
    const currentWallet = await Wallet.findById(user.Wallet).session(session);
    if (!currentWallet) {
      await Order.findByIdAndUpdate(id, { status: "new" }, { session });
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ message: "Wallet not found" });
    }

    // Step 4️⃣ Prepare payload (keep as-is)
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

    // Step 5️⃣ Serviceability check
    const { rate, requestToken, valueAddedServiceIds } =
      await checkAmazonServiceability("Amazon", payload);

    const isCOD = payload.payment_type === "COD";

    const shipmentData = {
      requestToken,
      rateId: rate,
      requestedDocumentSpecification: {
        format: "PDF",
        size: { width: 4.0, length: 6.0, unit: "INCH" },
        dpi: 300,
        pageLayout: "DEFAULT",
        needFileJoining: false,
        requestedDocumentTypes: ["LABEL"],
      },
      requestedValueAddedServices: [
        ...(isCOD ? [{ id: "CollectOnDelivery" }] : []),
      ],
    };

    // Step 6️⃣ Wallet check
    const walletHoldAmount = currentWallet.holdAmount || 0;
    const effectiveBalance = currentWallet.balance - walletHoldAmount;
    const balanceToBeDeducted =
      finalCharges === "N/A" ? 0 : parseFloat(finalCharges);
    const balance = currentWallet.balance + currentWallet.creditLimit;
    if (balance < balanceToBeDeducted) {
      await Order.findByIdAndUpdate(id, { status: "new" }, { session });
      await session.abortTransaction();
      session.endSession();
      return res
        .status(400)
        .json({ success: false, message: "Insufficient Wallet Balance" });
    }

    // Step 7️⃣ Amazon Shipment API call (keep as-is)
    const response = await axios.post(
      "https://sellingpartnerapi-eu.amazon.com/shipping/v2/shipments",
      shipmentData,
      {
        headers: {
          "x-amz-access-token": accessToken,
          "x-amzn-shipping-business-id": "AmazonShipping_IN",
          "Content-Type": "application/json",
        },
        timeout: 10000,
      }
    );

    if (!response?.data?.payload) {
      await Order.findByIdAndUpdate(id, { status: "new" }, { session });
      await session.abortTransaction();
      session.endSession();
      return res
        .status(400)
        .json({ message: "Error creating shipment", details: response.data });
    }

    const result = response.data.payload;
    const trackingId = result.packageDocumentDetails[0].trackingId;
    const base64Label =
      result.packageDocumentDetails[0].packageDocuments[0].contents;
    const labelBuffer = Buffer.from(base64Label, "base64");
    const labelKey = `labels/${Date.now()}_${
      currentOrder.orderId || "label"
    }.pdf`;

    const labelUrl = `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${labelKey}`;

    // Step 8️⃣ Update DB atomically (session)
    currentOrder.set({
      status: "Booked",
      cancelledAtStage: null,
      awb_number: trackingId,
      shipment_id: result.shipmentId,
      provider,
      totalFreightCharges: balanceToBeDeducted,
      courierServiceName,
      shipmentCreatedAt: new Date(),
      label: labelUrl,
      zone: zone.zone,
      estimatedDeliveryDate,
      tracking: [
        ...currentOrder.tracking,
        {
          status: "Booked",
          StatusLocation: currentOrder.pickupAddress?.city || "N/A",
          StatusDateTime: new Date(),
          Instructions: "Order booked successfully",
        },
      ],
    });

    await Promise.all([
      currentOrder.save({ session }),
      currentWallet.updateOne(
        {
          $inc: { balance: -balanceToBeDeducted },
          $push: {
            transactions: {
              channelOrderId: currentOrder.orderId || null,
              category: "debit",
              amount: balanceToBeDeducted,
              balanceAfterTransaction:
                currentWallet.balance - balanceToBeDeducted,
              date: new Date(),
              awb_number: trackingId,
              description: "Freight Charges Applied",
            },
          },
        },
        { session }
      ),
      s3.send(
        new PutObjectCommand({
          Bucket: process.env.AWS_BUCKET_NAME,
          Key: labelKey,
          Body: labelBuffer,
          ContentType: "application/pdf",
        })
      ),
    ]);

    await session.commitTransaction();
    session.endSession();

    // ✅ Final response
    return res.status(200).json({
      success: true,
      message: "Shipment Created Successfully",
      data: {
        orderId: currentOrder.orderId,
        waybill: trackingId,
        labelUrl,
      },
    });
  } catch (error) {
    await Order.findByIdAndUpdate(req.body.id, { status: "new" });
    await session.abortTransaction();
    session.endSession();
    console.error(
      "❌ Error creating shipment:",
      error.response?.data || error.message
    );
    return res.status(500).json({
      success: false,
      message: "Error creating shipment",
      details: error.response?.data || error.message,
    });
  }
};

const cancelShipment = async (shipmentId) => {
  // console.log("shipmet")
  const accessToken = await getAmazonAccessToken();
  // console.log("accessToken",accessToken)
  if (!accessToken) {
    // console.error("Failed to get access token");
    return;
  }
  console.log("shipement", shipmentId);
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

    // await Order.updateOne(
    //   { shipment_id: shipmentId },
    //   { $set: { status: "Cancelled" } }
    // );

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
      "Error cancelling shipmentttt:",
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
    // console.log("response", response.data.payload);
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

const getCorrectShipDate = () => {
  const now = new Date();
  let shipDate = new Date(now);
  const hour = now.getHours();
  const day = now.getDay(); // 0 = Sunday, 6 = Saturday

  // If Saturday after 2 PM → move to Monday
  if (day === 6 && hour >= 14) {
    shipDate.setDate(shipDate.getDate() + 2);
  }
  // If Sunday → move to Monday
  else if (day === 0) {
    shipDate.setDate(shipDate.getDate() + 1);
  }
  // Normal case
  else if (hour >= 14) {
    shipDate.setDate(shipDate.getDate() + 1);

    // If next day is Sunday → skip to Monday
    if (shipDate.getDay() === 0) {
      shipDate.setDate(shipDate.getDate() + 1);
    }
  }
  // console.log("shipdate",shipDate.toISOString().replace(/\.\d{3}Z$/, "Z"))
  return shipDate.toISOString().replace(/\.\d{3}Z$/, "Z");
};

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
      shipDate: getCorrectShipDate(),
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
