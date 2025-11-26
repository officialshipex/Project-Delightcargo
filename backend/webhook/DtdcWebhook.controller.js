const Order = require("../models/newOrder.model");
const Wallet = require("../models/wallet");
const statusMap = require("../statusMap/StatusMap.model");
const { formatDTDCDateTime } = require("../Orders/tracking.controller");

const DTDC_WEBHOOK_TOKEN = process.env.DTDC_WEBHOOK_TOKEN;

const DTDCWebhook = async (req, res) => {
  try {
    const token = req.headers.authorization;
    console.log("DTDC Webhook Token:", token);

    if (token !== DTDC_WEBHOOK_TOKEN) {
      return res.status(401).send("Unauthorized");
    }

    console.log("DTDC Webhook Received:", req.body);

    const { shipment, shipmentStatus } = req.body;

    if (!shipment || !shipment.strShipmentNo || !shipmentStatus?.length) {
      return res.status(400).send("Invalid Webhook Format");
    }

    // Extract AWB No.
    const awb = shipment.strShipmentNo.trim();

    // Find order
    const order = await Order.findOne({ awb_number: awb });
    if (!order) {
      return res.status(404).send("Order not found");
    }

    const statusObj = shipmentStatus[0];

    const normalizedData = {
      Status: statusObj.strAction || "",
      StatusDateTime: formatDTDCDateTime(
        statusObj.strActionDate,
        statusObj.strActionTime
      ),
      Instructions: statusObj.strActionDesc || "",
      StatusLocation: statusObj.strOrigin || "",
      StrRemarks:
        statusObj.strRemarks === "null" ? "" : statusObj.strRemarks || "",
    };

    // Add tracking entry
    order.tracking.push({
      status: normalizedData.Status,
      StatusDateTime: normalizedData.StatusDateTime,
      StatusLocation: normalizedData.StatusLocation,
      Instructions: normalizedData.Instructions,
    });

    // Load status mapping for DTDC
    const statusDoc = await statusMap.findOne(
      { partnerName: "DTDC" },
      { data: 1 }
    );

    let shouldUpdateWallet = false;
    let balanceTobeAdded = 0;

    if (statusDoc) {
      const dbMapping = statusDoc.data.find(
        (d) => d.code?.toLowerCase() === normalizedData.Status?.toLowerCase()
      );

      if (dbMapping) {
        // Update main status
        order.status = dbMapping.sy_status;

        // ------------------------------
        // ✔ PURE NDR: only if SETRTO
        // ------------------------------
        const isPureNDREligible =
          normalizedData.Status === "SETRTO" &&
          order.ndrStatus !== "Action_Requested";

        // ------------------------------
        // ✔ ANY UNDELIVERED STATUS
        // SETRTO or Regular Undelivered
        // ------------------------------
        if (dbMapping.sy_status === "Undelivered") {
          order.status = "Undelivered";
          order.ndrStatus = "Undelivered";

          // Prevent duplicate NDR entry by comparing timestamps
          const newDate = new Date(normalizedData.StatusDateTime);

          const lastNdr = order.ndrHistory[order.ndrHistory.length - 1];
          const lastAction = lastNdr?.actions?.[lastNdr.actions.length - 1];
          const lastDate = lastAction ? new Date(lastAction.date) : null;

          const canAddNewEntry =
            !lastDate || newDate.getTime() > lastDate.getTime();

          if (canAddNewEntry) {
            const attempt = order.ndrHistory.length + 1;

            order.ndrHistory.push({
              actions: [
                {
                  action: `NDR ${attempt} Raised`,
                  actionBy: order.courierServiceName,
                  remark: normalizedData.StrRemarks,
                  source: "DTDC",
                  date: normalizedData.StatusDateTime,
                },
              ],
            });
          }

          // SETRTO → eligible for NDR
          if (isPureNDREligible) {
            order.reattempt = true;
          } else {
            order.reattempt = false;
          }
        }

        // ------------------------------
        // ✔ Delivered Logic
        // ------------------------------
        if (dbMapping.code === "DLV") {
          if (order.ndrHistory.length > 0) {
            order.status = "Delivered";
            order.ndrStatus = "Delivered";
          } else {
            order.status = "Delivered";
            order.ndrStatus = null;
          }
          order.reattempt = false;
        }

        // ------------------------------
        // ✔ Refund logic
        // ------------------------------
        if (
          normalizedData.Instructions === "Return as per client instruction." &&
          order.tracking.length <= 3
        ) {
          order.status = "Cancelled";
          order.ndrStatus = "Cancelled";

          balanceTobeAdded =
            order.totalFreightCharges === "N/A"
              ? 0
              : parseInt(order.totalFreightCharges);

          shouldUpdateWallet = true;
        }

        // ------------------------------
        // ✔ All non-NDR, non-Undelivered statuses
        // ------------------------------
        if (dbMapping.sy_status !== "Undelivered" && !isPureNDREligible) {
          order.reattempt = false;
        }
      }
    }

    // Refund wallet if needed
    if (shouldUpdateWallet && balanceTobeAdded > 0) {
      await Wallet.findByIdAndUpdate(order.walletId, {
        $inc: { balance: balanceTobeAdded },
      });
    }

    await order.save();
    console.log("DTDC Webhook Processed for AWB:", awb);
    return res.status(200).send("Webhook Processed");
  } catch (err) {
    console.error("DTDC Webhook Error:", err.message);
    return res.status(500).send("Internal Server Error");
  }
};

module.exports = { DTDCWebhook };
