const axios = require("axios");
const Order = require("../../models/newOrder.model");
const User = require("../../models/User.model");
const Wallet = require("../../models/wallet");
const { getZone } = require("../../Rate/zoneManagementController");
const {
  getAuthToken,
} = require("../../AllCouriers/Zipypost/Authorize/zipyPost.controller");
const {
  createWarehouse,
} = require("../../AllCouriers/Zipypost/Couriers/couriers.controller");
const {
  checkZipypostServiceability,
} = require("../../AllCouriers/Zipypost/Couriers/couriers.controller");
const mongoose = require("mongoose");
const warehouseCache = new Map();
const estimatedDeliveryDate = require("../../models/EDDMap.model");
const {
  getCachedZone,
} = require("../../AllCouriers/Zipypost/Couriers/couriers.controller");

const createZipypostShipment = async ({
  id,
  provider,
  finalCharges,
  courierServiceName,
}) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // ✅ Step 1: Fetch order safely
    const currentOrder = await Order.findOneAndUpdate(
      { _id: id, status: "new" },
      { $set: { status: "processing" } },
      { new: true, session }
    );

    if (!currentOrder) {
      return {
        success: false,
        message:
          "Shipment already created or order is being processed by another request.",
      };
    }

    // ✅ Step 2: Fetch user and wallet
    const user = await User.findById(currentOrder.userId).session(session);
    if (!user) throw new Error("User not found");
    if (!user.Wallet) throw new Error("User wallet not found");

    const currentWallet = await Wallet.findById(user.Wallet).session(session);
    if (!currentWallet) throw new Error("Wallet not found");

    // ✅ Step 3: Check wallet balance
    const hold = currentWallet.holdAmount || 0;
    const effectiveBalance = currentWallet.balance - hold;
    if (currentWallet.balance < finalCharges)
      throw new Error("Insufficient wallet balance");

    // ✅ Step 4: Get zone (cached for speed)
    const zone = await getCachedZone(
      currentOrder.pickupAddress.pinCode,
      currentOrder.receiverAddress.pinCode
    );
    if (!zone) throw new Error("Pincode not serviceable");

    // ✅ Estimate Delivery Date (from DB)
    const eddData = await estimatedDeliveryDate.findOne({
      courier: "ZipyPost",
      serviceName: courierServiceName.trim(),
    });

    let estimateDate = null;
    if (eddData) {
      let deliveryDays = null;
      if (
        eddData.zoneRates &&
        typeof eddData.zoneRates[zone.zone] === "number"
      ) {
        deliveryDays = eddData.zoneRates[zone.zone];
      } else if (typeof eddData[zone.zone] === "number") {
        deliveryDays = eddData[zone.zone];
      }

      if (deliveryDays) {
        estimateDate = new Date();
        estimateDate.setDate(estimateDate.getDate() + deliveryDays);
      }
    }

    // ✅ Step 5: Auth and serviceability
    const sellerId = process.env.ZIPYPOST_SELLER_ID;
    const token = await getAuthToken();

    const payload = {
      source_pincode: currentOrder.pickupAddress.pinCode,
      destination_pincode: currentOrder.receiverAddress.pinCode,
      payment_type: currentOrder.paymentDetails?.method,
      order_weight: currentOrder.packageDetails.applicableWeight,
      length: currentOrder.packageDetails.volumetricWeight?.length || 0,
      breadth: currentOrder.packageDetails.volumetricWeight?.width || 0,
      height: currentOrder.packageDetails.volumetricWeight?.height || 0,
      order_value: currentOrder.paymentDetails?.amount || 0,
    };

    const serviceability = await checkZipypostServiceability(payload);
    if (!serviceability?.data?.length)
      throw new Error("No serviceable courier available");

    const validCouriers = serviceability.data.filter(
      (svc) => svc.courier_id === 9 || svc.courier_id === 10
    );

    let courier_id = 0;
    if (courierServiceName.toLowerCase().includes("xpressbees")) courier_id = 9;
    else if (courierServiceName.toLowerCase().includes("bluedart"))
      courier_id = 10;

    if (!courier_id) throw new Error("Only Xpressbees and Bluedart supported.");

    const courierOptions = validCouriers.filter(
      (svc) => svc.courier_id === courier_id
    );

    const applicableWeight = currentOrder.packageDetails.applicableWeight;
    const selectedMode =
      courierOptions.find(
        (option) => applicableWeight <= parseFloat(option.slab)
      ) || courierOptions[courierOptions.length - 1];

    if (!selectedMode) throw new Error("Unable to determine courier mode_id");
    const mode_id = selectedMode.mode_id;

    // ✅ Step 6: Cached warehouse creation
    const whKey = `${currentOrder.userId}-${currentOrder.pickupAddress.pinCode}`;
    let warehouseId = warehouseCache.get(whKey);

    if (!warehouseId) {
      const baseName = (
        currentOrder.pickupAddress.contactName || "Warehouse"
      ).substring(0, 10);
      const shortUserId = currentOrder.userId.toString().substring(0, 6);
      const finalWarehouseName =
        `${baseName}-${shortUserId}-${currentOrder.pickupAddress.pinCode}`.substring(
          0,
          30
        );

      const warehouseData = {
        warehouseName: finalWarehouseName,
        contactName: currentOrder.pickupAddress.contactName,
        contactNumber: currentOrder.pickupAddress.phoneNumber?.replace(
          /^0+/,
          ""
        ),
        AddressLineOne:
          currentOrder.pickupAddress.address?.substring(0, 45) || "",
        AddressLineTwo:
          currentOrder.pickupAddress.address?.substring(0, 45) || "",
        pincode: currentOrder.pickupAddress.pinCode,
        city: currentOrder.pickupAddress.city,
        primary: true,
      };

      const whResult = await createWarehouse(
        currentOrder.userId,
        warehouseData,
        token.authToken,
        token.timestamp,
        sellerId
      );

      if (!whResult.success)
        throw new Error(
          "Pickup pincode not registered. Please add a pickup address first."
        );

      warehouseCache.set(whKey, whResult.warehouseId);
      warehouseId = whResult.warehouseId;
    }

    // ✅ Step 7: Prepare shipment creation payload
    const totalProducts = currentOrder.productDetails.length;

    const requestBody = {
      order_number: currentOrder.orderId,
      purchase_amount: currentOrder.paymentDetails.amount,
      purchase_date: currentOrder.createdAt.toISOString().split("T")[0],
      billing_details_same_as_shipping: true,
      shipping_details: {
        full_name: currentOrder.receiverAddress.contactName,
        contact_number: currentOrder.receiverAddress.phoneNumber?.replace(
          /^0+/,
          ""
        ),
        customer_email:
          currentOrder.receiverAddress.email || "example@email.com",
        address_line_one: currentOrder.receiverAddress.address?.slice(0, 104),
        address_line_two: currentOrder.receiverAddress.address?.slice(0, 104),
        pincode: currentOrder.receiverAddress.pinCode,
        city: currentOrder.receiverAddress.city,
      },
      billing_details: {
        full_name: currentOrder.pickupAddress.contactName,
        contact_number: currentOrder.pickupAddress.phoneNumber?.replace(
          /^0+/,
          ""
        ),
        address_line_one:
          currentOrder.pickupAddress.address?.substring(0, 45) || "",
        address_line_two:
          currentOrder.pickupAddress.address?.substring(45, 90) || "",
        pincode: currentOrder.pickupAddress.pinCode,
        city: currentOrder.pickupAddress.city,
      },
      items: currentOrder.productDetails.map((p) => ({
        sku: p.sku?.length >= 3 ? p.sku : `SKU${currentOrder.orderId}`,
        item_name: p.name,
        quantity: p.quantity || 1,
        item_weight:
          currentOrder.packageDetails.applicableWeight / totalProducts,
        item_price: p.unitPrice,
      })),
      package_length: currentOrder.packageDetails.length || 10,
      package_width: currentOrder.packageDetails.width || 10,
      package_height: currentOrder.packageDetails.height || 10,
      package_weight: currentOrder.packageDetails.applicableWeight || 0.5,
      warehouse_id: warehouseId,
      payment_type: currentOrder.paymentDetails.method === "COD" ? 2 : 1,
      courier_id,
      mode_id,
    };

    // ✅ Step 8: Create shipment via API
    const response = await axios.post(
      "https://api.zipypost.com/create/shipment",
      requestBody,
      {
        headers: {
          "Content-Type": "application/json",
          authorization: token.authToken,
          timestamp: token.timestamp,
          sellerid: sellerId,
        },
      }
    );

    if (!response.data.success || !response.data.booking) {
      throw new Error(response.data.message || "Failed to create shipment");
    }

    const result = response.data.RESULT;

    // ✅ Step 9: Update DB atomically
    currentOrder.status = "Booked";
    currentOrder.awb_number = result.awb;
    currentOrder.shipment_id = currentOrder.orderId;
    currentOrder.provider = result.courier?.replace(/\+/g, "").trim();
    currentOrder.partner = "ZipyPost";
    currentOrder.shipmentCreatedAt = new Date();
    currentOrder.totalFreightCharges = finalCharges || 0;
    currentOrder.courierServiceName = courierServiceName;
    currentOrder.zone = zone.zone;

    // 🔹 Take estimatedDeliveryDate from DB
    currentOrder.estimatedDeliveryDate =estimateDate || "";

    currentOrder.tracking.push({
      status: "Booked",
      StatusLocation: currentOrder.pickupAddress.city,
      StatusDateTime: new Date(),
      Instructions: "Order booked successfully",
    });

    currentWallet.balance -= finalCharges;
    currentWallet.transactions.push({
      channelOrderId: currentOrder.orderId,
      category: "debit",
      amount: finalCharges,
      balanceAfterTransaction: currentWallet.balance,
      date: new Date(),
      awb_number: result.awb,
      description: "Freight Charges Applied",
    });

    await Promise.all([
      currentOrder.save({ session }),
      currentWallet.save({ session }),
    ]);

    await session.commitTransaction();
    session.endSession();

    return {
      success: true,
      message: "Shipment Created Successfully",
      awb_number: result.awb,
    };
  } catch (error) {
    await session.abortTransaction();
    if (id) {
      await Order.updateOne(
        { _id: id, status: "processing" },
        { $set: { status: "new" } }
      );
    }
    session.endSession();

    console.error(
      "Error creating Zipypost shipment:",
      error?.response?.data || error.message
    );
    return {
      success: false,
      message:
        error?.response?.data?.error?.booking_process_error ||
        "Failed to create shipment",
    };
  }
};

module.exports = createZipypostShipment;
