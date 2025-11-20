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

    // Normalize webhook status object
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
      remark: normalizedData.StrRemarks,
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
        // ----------------------------------------------
        // 1. Default: Update main status
        // ----------------------------------------------
        order.status = dbMapping.sy_status;

        // ----------------------------------------------
        // 2. RTO Special Cases
        // ----------------------------------------------
        if (dbMapping.sy_status === "Cancelled" && order.tracking.length > 3) {
          order.status = "RTO";
        }

        // ----------------------------------------------
        // 3. Update NDR Status
        // ----------------------------------------------
        if (
          ["Undelivered", "RTO", "RTO In-transit", "RTO Delivered"].includes(
            dbMapping.sy_status
          )
        ) {
          order.ndrStatus = dbMapping.sy_status;
        }

        // ----------------------------------------------
        // 4. Handling Delivered Status
        // ----------------------------------------------
        if (dbMapping.code === "DLV") {
          if (order.ndrHistory.length > 0) {
            // Delivered AFTER NDR → mark both
            order.status = "Delivered";
            order.ndrStatus = "Delivered";
          } else {
            // Delivered normally
            order.status = "Delivered";
            order.ndrStatus = null;
          }

          order.reattempt = false;
        }

        // ----------------------------------------------
        // 5. Pure NDR raising (Undelivered)
        // ----------------------------------------------
        if (
          dbMapping.sy_status === "Undelivered" ||
          dbMapping.code === "RTONONDLV"
        ) {
          order.status = "Undelivered";
          order.ndrStatus = "Undelivered";
          order.ndrReason = {
            date: normalizedData.StatusDateTime,
            reason: normalizedData.StrRemarks,
          };

          // Add NDR history entry (max 3)
          const lastNdr = order.ndrHistory[order.ndrHistory.length - 1];
          const lastAction = lastNdr?.actions?.[lastNdr.actions.length - 1];

          const lastDate = lastAction?.date
            ? new Date(lastAction.date).toDateString()
            : null;
          const currentDate = new Date(
            normalizedData.StatusDateTime
          ).toDateString();

          if (
            (lastDate !== currentDate || order.ndrHistory.length === 0) &&
            order.ndrHistory.length < 3
          ) {
            const attempt = order.ndrHistory.length + 1;

            const newEntry = {
              actions: [
                {
                  action: `NDR ${attempt} Raised`,
                  actionBy: order.courierServiceName,
                  remark: normalizedData.StrRemarks,
                  source: "DTDC",
                  date: normalizedData.StatusDateTime,
                },
              ],
            };

            order.ndrHistory.push(newEntry);
          }
        }

        // ----------------------------------------------
        // 6. Wallet refund logic (Cancelled with condition)
        // ----------------------------------------------
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

        // ----------------------------------------------
        // 7. Final reattempt logic (pure NDR)
        // ----------------------------------------------
        order.reattempt =
          order.ndrHistory.length > 0 && order.status === "Undelivered";
      }
    }

    // Refund wallet if needed
    if (shouldUpdateWallet && balanceTobeAdded > 0) {
      await Wallet.findByIdAndUpdate(order.walletId, {
        $inc: { balance: balanceTobeAdded },
      });
    }

    await order.save();

    return res.status(200).send("Webhook Processed");
  } catch (err) {
    console.error("DTDC Webhook Error:", err.message);
    return res.status(500).send("Internal Server Error");
  }
};

module.exports = { DTDCWebhook };
