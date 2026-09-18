const { refreshToken } = require("../Authorize/delhivery.controller");
const BASE_URL = process.env.DEL_URL;
const axios = require("axios");
// Node's built-in global FormData (Web API) has no .getHeaders() method,
// which axios/form-data's multipart flow needs to set the boundary header
// on a Node http request — this shadows it with the npm form-data package
// that the rest of the codebase already uses for multipart uploads.
const FormData = require("form-data");

// Delhivery's B2B manifest API parses JSON-shaped multipart fields
// (shipment_details, dropoff_location, invoices, billing_address, callback)
// with something resembling Python's ast.literal_eval rather than a real
// JSON parser — confirmed live: a field containing a standard JSON `false`
// is rejected outright (e.g. "shipment_details: value is not a valid
// list"), while Delhivery's own example payload in their LTL Postman
// collection embeds a capitalized `False`. This converts JSON's
// true/false/null to Python's True/False/None before sending.
const toDelhiveryJSON = (value) =>
  JSON.stringify(value)
    .replace(/\btrue\b/g, "True")
    .replace(/\bfalse\b/g, "False")
    .replace(/\bnull\b/g, "None");
const User = require("../../../../../../models/User.model");
const Wallet = require("../../../../../../models/wallet");
const WalletTransaction = require("../../../../../../models/WalletTransaction.model");
const mongoose = require("mongoose");
const Order = require("../../../../../../models/newOrder.model");
const crypto = require("crypto");
const { getAuthoritativeB2BRate } = require("../../../../../utils/b2bRateEngine");

const createdDelhiveryB2BWarehouses = new Set();

// Helper function to generate a unique warehouse name for Delhivery
const getUniqueWarehouseName = (payload) => {
  const address = payload?.address || payload?.addressLine1 || "";
  const pinCode = payload?.pinCode || "";
  const phoneNumber = payload?.phoneNumber || payload?.contactNo || "";
  const contactName = payload?.contactName || "Default Warehouse";

  if (!address) return contactName;

  const addressKey = `${address}-${pinCode}-${phoneNumber}`
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  const hash = crypto
    .createHash("md5")
    .update(addressKey)
    .digest("hex")
    .substring(0, 6);
  return `${contactName.substring(0, 30)}-${hash}`.trim();
};

const createClientWarehouseB2B = async (payload, token) => {
  if (!payload) {
    throw new Error("Payload is required to create a warehouse.");
  }

  const uniqueName = getUniqueWarehouseName(payload);

  if (createdDelhiveryB2BWarehouses.has(uniqueName)) {
    return {
      success: true,
      message: "Warehouse already exists (cached), proceeding",
      name: uniqueName,
    };
  }

  const phone = payload.phoneNumber || payload.contactNo || "";
  const address = payload.address || payload.addressLine1 || "";

  // Was POSTing to `${DELHIVERY_URL or track.delhivery.com}/b2b/api/v1/clientwarehouse/create/`
  // — same wrong-domain bug as pincode serviceability (track.delhivery.com
  // is the Express tracking portal, 404s on every B2B path). Confirmed the
  // real endpoint and schema live against the API itself (the docs at
  // one.delhivery.com are a JS SPA with no static content to scrape — no
  // content API could be found in its bundle either): POST
  // /client-warehouse/create/ on BASE_URL (DEL_URL, the LTL host), with a
  // schema that doesn't match the old flat payload at all — pin_code is a
  // top-level integer, and address/phone live under nested address_details,
  // with a separate ret_address block (return address) that uses `pin` as
  // a string instead of `pin_code`.
  const warehouseDetails = {
    name: uniqueName,
    city: payload.city,
    state: payload.state,
    country: "India",
    pin_code: Number(payload.pinCode),
    address_details: {
      address,
      phone_number: phone,
    },
    ret_address: {
      address,
      pin: String(payload.pinCode),
      country: "India",
    },
  };

  try {
    const response = await axios.post(
      `${BASE_URL}/client-warehouse/create/`,
      warehouseDetails,
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      }
    );

    if (response.data?.success) {
      createdDelhiveryB2BWarehouses.add(uniqueName);
      return {
        success: true,
        message: "B2B Warehouse created successfully",
        name: uniqueName,
        data: response.data,
      };
    } else {
      const errorMessage = response.data?.error?.message || response.data?.message || "";
      if (errorMessage.includes("already exists")) {
        createdDelhiveryB2BWarehouses.add(uniqueName);
        return {
          success: true,
          message: "B2B Warehouse already exists, proceeding",
          name: uniqueName,
          data: response.data,
        };
      } else {
        throw new Error(errorMessage || "B2B Warehouse creation failed.");
      }
    }
  } catch (error) {
    // The real API returns the duplicate-name error as error.message (a
    // string), not error[0] (the old code assumed an array shape that
    // doesn't match this endpoint's actual response at all).
    const errorMessage = error.response?.data?.error?.message || error.response?.data?.message || "";
    if (errorMessage.includes("already exists")) {
      createdDelhiveryB2BWarehouses.add(uniqueName);
      return {
        success: true,
        message: "B2B Warehouse already exists, proceeding",
        name: uniqueName,
      };
    } else {
      console.error(
        "Error creating B2B warehouse:",
        error.response?.data || error.message
      );
      throw new Error(errorMessage || "Failed to create B2B warehouse.");
    }
  }
};

// ================================================================
// SHIPMENT CREATION — mirrors BigShip's 3-phase transaction structure
// (see AllCouriers/BigShip/Courier/couriers.controller.js): a short
// DB-only phase to lock the order and check the wallet, THEN the slow
// external calls (warehouse + manifest) with no transaction held open,
// THEN a short retried phase to persist the debit + order update. This
// used to be one long transaction spanning both external HTTP calls —
// if the manifest call succeeded but the transaction then failed to
// commit (a transient write conflict), the abort would silently undo
// the wallet debit and reset the order to "new" while Delhivery had
// already created a real, billable manifest job with no local record
// of it at all. Splitting the phases means the debit only ever happens
// AFTER we know the manifest job is real, and a phase-3 persistence
// failure after retries is a logged reconciliation issue instead of a
// silently lost charge.
// ================================================================
const createDelhiveryB2BShipment = async (req, res) => {
  const { id, provider, courierServiceName } = req.body;
  console.log("Creating Delhivery B2B Shipment for Order ID:", req.body);

  const revertToNew = () => Order.updateOne({ _id: id }, { $set: { status: "new" } }).catch(() => {});

  // ── PHASE 1: lock the order, then debit the wallet ATOMICALLY ───────────
  // The wallet check-and-debit used to be two separate steps: read the
  // balance here, then apply the $inc later in phase 3 (after the slow
  // external call). That gap is a real race: if two orders for the SAME
  // wallet are booked at the same moment, both can read a "sufficient"
  // balance before either has actually been debited, and both proceed —
  // over-drafting the wallet past what it should ever allow. The fix is to
  // make "is there enough balance" and "take it" a single atomic operation:
  // findOneAndUpdate's query filter is evaluated against each candidate
  // document by MongoDB itself, so a $expr condition on balance/hold/credit
  // right there in the filter means the check and the $inc happen as one
  // indivisible step — immune to races no matter how many bookings hit the
  // same wallet at once. No transaction or retry-on-write-conflict is
  // needed for this specific step because a single findOneAndUpdate on one
  // document is already atomic by itself.
  let order, finalCharges, rateBreakup, walletId, debitedBalance;

  order = await Order.findOneAndUpdate(
    { _id: id, status: "new" },
    { $set: { status: "processing" } },
    { new: true }
  );
  if (!order) {
    return res.status(400).json({ success: false, message: "Order already processed" });
  }
  if (order.orderType !== "B2B") {
    await revertToNew();
    return res.status(400).json({ success: false, message: "Delhivery supports B2B only" });
  }

  try {
    // Never trust a client-supplied finalCharges/rateBreakup for a wallet
    // debit — recompute it from the order's own active rate card.
    const rate = await getAuthoritativeB2BRate({
      order,
      provider: "Delhivery",
      courierServiceName,
    });
    finalCharges = rate.working.grand_total;
    rateBreakup = rate.working;
  } catch (err) {
    await revertToNew();
    return res.status(400).json({ success: false, message: err.message });
  }

  const user = await User.findById(order.userId);
  walletId = user.Wallet;

  const debitedWallet = await Wallet.findOneAndUpdate(
    {
      _id: walletId,
      $expr: {
        $gte: [
          { $add: [{ $subtract: ["$balance", { $ifNull: ["$holdAmount", 0] }] }, { $ifNull: ["$creditLimit", 0] }] },
          finalCharges,
        ],
      },
    },
    { $inc: { balance: -finalCharges } },
    { new: true }
  );

  if (!debitedWallet) {
    await revertToNew();
    return res.status(400).json({ success: false, message: "Insufficient Wallet Balance" });
  }
  debitedBalance = debitedWallet.balance;

  await WalletTransaction.create({
    walletId,
    channelOrderId: order.orderId,
    category: "debit",
    amount: finalCharges,
    balanceAfterTransaction: debitedBalance,
    description: "Freight Charges Applied",
    date: new Date(),
  });

  // ── PHASE 2: the slow external calls — wallet is already correctly
  // debited above, so any failure from here just needs a compensating
  // refund (not a transaction rollback, since phase 1 already committed).
  const refundDebit = async () => {
    const refunded = await Wallet.findByIdAndUpdate(walletId, { $inc: { balance: finalCharges } }, { new: true });
    await WalletTransaction.create({
      walletId,
      channelOrderId: order.orderId,
      category: "credit",
      amount: finalCharges,
      balanceAfterTransaction: refunded ? refunded.balance : debitedBalance + finalCharges,
      description: "Freight Charges Received",
      date: new Date(),
    }).catch((e) => console.error("⚠️ Delhivery B2B compensating-refund WalletTransaction failed:", e.message));
  };

  let jobId;
  try {
    // Delhivery's manifest validator rejects an empty/missing
    // shipment_details list outright ("value is not a valid list") rather
    // than a clearer "no boxes" message — surface it as a real 400 here
    // instead, since an order with no package/box details can never be
    // manifested no matter how many times it's retried.
    if (!order.B2BPackageDetails?.packages?.length) {
      throw new Error(
        "This order has no package/box details (B2BPackageDetails.packages is empty) — add box details before booking."
      );
    }

    const totalWeight = order.B2BPackageDetails.packages.reduce(
      (s, p) => s + p.noOfBox * p.weightPerBox,
      0
    );

    const token = await refreshToken(courierServiceName || order.courierServiceName);

    // Register/Create the B2B client warehouse if needed
    const warehouseResult = await createClientWarehouseB2B(order.pickupAddress, token);
    const pickupWarehouseName = warehouseResult.name || getUniqueWarehouseName(order.pickupAddress);

    const form = new FormData();

    // form-data's append() requires every value to be a string, Buffer, or
    // stream — a raw number/boolean isn't stringified for you, it's handed
    // straight to the underlying request stream's .write(), which throws
    // ("data should be a string, Buffer or Uint8Array") the moment it hits
    // a non-string chunk. Every non-string field below must be String()'d.
    form.append("pickup_location_name", pickupWarehouseName);
    form.append("payment_mode", order.paymentDetails.method.toLowerCase());
    form.append(
      "cod_amount",
      String(order.paymentDetails.method === "COD" ? order.paymentDetails.amount : 0)
    );
    // Weight needs to be in grams for Delhivery B2B Create LR API
    form.append("weight", String(totalWeight * 1000));
    // rov_insurance/fm_pickup are plain (non-JSON) form fields, but
    // Delhivery still expects Python-style capitalized "True"/"False"
    // strings here, not lowercase — confirmed against their own Postman
    // collection example and live testing.
    form.append("rov_insurance", order.rovType?.toLowerCase().includes("carrier") ? "True" : "False");
    // Delhivery only supports "fop" (Freight on Pickup, billed to the
    // shipper account) or "fod" (Freight on Delivery) — "fop" returned a
    // hard account-level rejection ("FoP orders not allowed for this
    // client") for this Delhivery B2B account, confirmed live, so this
    // account is provisioned for FoD instead.
    form.append("freight_mode", "fod");
    form.append("fm_pickup", "True");

    const publicUrl = process.env.BACKEND_PUBLIC_URL || "https://api.delightcargo.in";
    const webhookSecret = process.env.DELHIVERY_WEBHOOK_SECRET || process.env.DELHIVERY_WEBHOOK_TOKEN;

    /* 🔔 CALLBACK CONFIG */
    form.append(
      "callback",
      toDelhiveryJSON({
        uri: `${publicUrl}/v1/webhook/delhivery/manifest`,
        method: "POST",
        authorization: `Bearer ${webhookSecret}`,
        headers: { "Content-Type": "application/json" },
      })
    );

    form.append(
      "dropoff_location",
      toDelhiveryJSON({
        consignee_name: order.receiverAddress.contactName,
        address: order.receiverAddress.address,
        city: order.receiverAddress.city,
        state: order.receiverAddress.state,
        zip: order.receiverAddress.pinCode,
        phone: order.receiverAddress.phoneNumber,
        email: order.receiverAddress.email || "",
      })
    );

    form.append(
      "invoices",
      toDelhiveryJSON([
        {
          ewaybill: order.otherDetails?.ewaybill || "",
          inv_num: `INV-${order.orderId}`,
          inv_amt: order.paymentDetails.amount,
          inv_date: new Date().toISOString().split("T")[0],
          inv_qr_code: "",
        },
      ])
    );

    const shipmentDetails = order.B2BPackageDetails.packages.map((pkg, i) => ({
      order_id: `${order.orderId}-${i + 1}`,
      box_count: pkg.noOfBox,
      description: "B2B Cargo",
      weight: pkg.noOfBox * pkg.weightPerBox * 1000, // weight in grams
      waybills: [],
      master: false,
    }));
    form.append("shipment_details", toDelhiveryJSON(shipmentDetails));

    form.append(
      "billing_address",
      toDelhiveryJSON({
        name: order.pickupAddress.contactName,
        company: order.pickupAddress.contactName,
        consignor: order.pickupAddress.contactName,
        address: order.pickupAddress.address,
        city: order.pickupAddress.city,
        state: order.pickupAddress.state,
        pin: order.pickupAddress.pinCode,
        phone: order.pickupAddress.phoneNumber,
        // Delhivery validates gst_number against a regex that only accepts
        // a real GSTIN or the literal placeholders "UR" (unregistered) /
        // "TE" — an empty string matches neither and fails validation
        // outright. Confirmed live.
        gst_number: order.otherDetails?.gstin || "UR",
      })
    );

    const manifestRes = await axios.post(`${BASE_URL}/manifest`, form, {
      headers: {
        Authorization: `Bearer ${token}`,
        ...form.getHeaders(),
      },
    });

    jobId = manifestRes.data?.job_id;
    if (!jobId) throw new Error("Delhivery manifest failed");
  } catch (err) {
    console.error("Error in Delhivery B2B Shipment (external phase):", err.response?.data || err.message);
    // Delhivery never confirmed a real job — refund the phase-1 debit and
    // free the wallet balance back up before reverting the order.
    await refundDebit();
    await revertToNew();
    return res.status(500).json({ success: false, message: err.message });
  }

  // ── PHASE 3: point of no return reached — Delhivery already created a
  // real, billable manifest job, and the wallet is already correctly
  // debited from phase 1. Just persist the order's Booked status + jobId,
  // retrying on write conflict — no wallet logic here anymore, so a
  // phase-3 failure after retries is purely a record-keeping gap (the
  // money side is already settled and correct), not a financial one.
  let persisted = false;
  for (let attempt = 1; attempt <= 3 && !persisted; attempt++) {
    try {
      await Order.findByIdAndUpdate(order._id, {
        $set: {
          status: "Booked",
          provider: provider || "Delhivery",
          courierServiceName,
          manifestJobId: jobId,
          totalFreightCharges: finalCharges,
          rateBreakup,
          walletDeducted: true,
          // Set by every other courier integration in this codebase at
          // booking time (used for B2B order sorting, dashboards, and the
          // invoice "Booked On" column) — was missing here entirely.
          // Stored as true UTC like every other integration sets it
          // (unlike tracking[].StatusDateTime, which is deliberately
          // pre-shifted to IST for direct display).
          shipmentCreatedAt: new Date(),
        },
        $push: {
          tracking: {
            status: "Booked",
            Instructions: "Delhivery manifest created",
            StatusLocation: order.pickupAddress?.city || "N/A",
            // Stored pre-shifted to IST, matching every other courier
            // integration's convention — the UI displays this as-is with
            // no further timezone conversion.
            StatusDateTime: new Date(Date.now() + 5.5 * 60 * 60 * 1000),
          },
        },
      });
      persisted = true;
    } catch (error) {
      if (attempt === 3) {
        console.error(
          `[Delhivery B2B createShipment] CRITICAL: manifest job ${jobId} (order ${id}) was placed and wallet debited, but the order record could not be updated after 3 attempts — needs manual reconciliation:`,
          error.message
        );
      } else {
        console.warn(`[Delhivery B2B createShipment] Write conflict persisting manifest ${jobId} on attempt ${attempt}. Retrying in ${50 * attempt}ms...`);
        await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
      }
    }
  }

  // Success is reported based on Delhivery's own confirmation, not on
  // whether phase 3 fully persisted — the manifest job is real either way,
  // and a rare phase-3 failure after 3 retries is a logged reconciliation
  // issue, not a reason to tell the customer their booking failed when it
  // didn't.
  res.json({ success: true, job_id: jobId });

  /* ================================
     ASYNC STATUS CHECK FALLBACK
  ================================= */
  setTimeout(
    () => getDelhiveryB2BShipmentDetailsInternal(jobId),
    60 * 1000
  );
};

// Bounded retry count/delay for the fallback below — a fresh manifest job
// usually resolves within 10-15s (well inside the first 60s check), but
// isn't guaranteed to. Without a retry, a job still "processing" at the
// 60s mark would be checked exactly once and then left stuck at "Booked"
// forever unless the webhook independently fires — this keeps checking a
// few more times instead of relying on the webhook alone.
const MANIFEST_STATUS_MAX_ATTEMPTS = 5;
const MANIFEST_STATUS_RETRY_DELAY_MS = 45 * 1000;

const getDelhiveryB2BShipmentDetailsInternal = async (jobId, attempt = 1) => {
  try {
    const order = await Order.findOne({ manifestJobId: jobId });
    if (!order) return;

    if (order.awb_number && order.status === "Ready To Ship") return;

    const token = await refreshToken(order.courierServiceName || order.provider);

    const response = await axios.get(
      `${BASE_URL}/manifest`,
      {
        params: { job_id: jobId },
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    console.log("Delhivery Cargo Job Details:", response.data);
    // The real payload is nested under response.data.data (the same
    // {success, data, request_id} envelope used everywhere else in this
    // file) — response.data.status is always undefined. Falling back to
    // response.data defensively in case a differently-shaped response
    // ever comes back flat.
    const data = response.data?.data || response.data || {};
    const rawStatus = data.status || data.state || "";
    const normalizedStatus = String(rawStatus).toUpperCase();
    // Confirmed live: a completed job reports status "Complete", not
    // "SUCCESS" as originally assumed — matching both defensively since
    // Delhivery's exact vocabulary here isn't documented.
    const isComplete = normalizedStatus === "COMPLETE" || normalizedStatus === "COMPLETED" || normalizedStatus === "SUCCESS";
    const isFailed = normalizedStatus.includes("FAIL") || normalizedStatus.includes("ERROR") || normalizedStatus.includes("REJECT");

    /* ================================
       ❌ SHIPMENT FAILED → REFUND
    ================================= */
    if (isFailed) {
      if (order.walletDeducted) {
        // This async fallback and the Delhivery webhook
        // (delhiveryManifestCallback) can both observe the same failed job
        // and race to refund it — checking `!order.walletRefunded` from
        // the read above and refunding afterward is NOT atomic, so both
        // could pass the check before either has written back, causing a
        // double refund. Claiming the refund via this conditional
        // findOneAndUpdate FIRST makes "is this still unrefunded" and
        // "claim it" one indivisible step — whichever of the two callers
        // runs this first wins, and the other sees walletRefunded already
        // true and does nothing further.
        const claimedOrder = await Order.findOneAndUpdate(
          { _id: order._id, walletRefunded: { $ne: true } },
          {
            $set: { walletRefunded: true, status: "Cancelled" },
            $push: {
              tracking: {
                status: "Cancelled",
                Instructions: data.error || data.remarks || "Delhivery manifest failed",
                StatusLocation: order.pickupAddress?.city || "N/A",
                StatusDateTime: new Date(Date.now() + 5.5 * 60 * 60 * 1000),
              },
            },
          },
          { new: true }
        );

        if (claimedOrder) {
          const refundAmount = Number(claimedOrder.totalFreightCharges);
          const refundUser = await User.findById(claimedOrder.userId).select("Wallet");
          const refundedWallet = await Wallet.findByIdAndUpdate(
            refundUser.Wallet,
            { $inc: { balance: refundAmount } },
            { new: true }
          );

          await WalletTransaction.create([{
            walletId: refundUser.Wallet,
            category: "credit",
            channelOrderId: claimedOrder.orderId,
            amount: refundAmount,
            balanceAfterTransaction: refundedWallet.balance,
            description: "Freight Charges Received",
            date: new Date(),
          }]);
        }
      }
      return;
    }

    /* ================================
       ✅ COMPLETE → SAVE LRN + AWB + CHILD AWBs
    ================================= */
    if (isComplete) {
      // Confirmed live field names: lrnum (not lrn), waybills (not awbs,
      // one per box), master_waybill (which of those is the primary AWB —
      // falls back to the first waybill if that field is ever absent).
      const lrn = data.lrnum || data.lrn || null;
      const awbList = data.waybills || data.awbs || [];
      const awb = data.master_waybill || awbList[0] || data.waybill_number || data.awb || null;

      await Order.findByIdAndUpdate(order._id, {
        $set: {
          awb_number: awb,
          lrn,
          child_awb_numbers: awbList,
          status: "Ready To Ship",
        },
        $push: {
          tracking: {
            status: "Ready To Ship",
            Instructions: "LR & AWB generated by Delhivery",
            StatusLocation: order.pickupAddress?.city || "N/A",
            StatusDateTime: new Date(Date.now() + 5.5 * 60 * 60 * 1000),
          },
        },
      });

      const user = await User.findById(order.userId).select("Wallet");
      await WalletTransaction.updateOne(
        {
          walletId: user.Wallet,
          channelOrderId: order.orderId,
          category: "debit"
        },
        {
          $set: {
            awb_number: awb
          }
        }
      ).catch(e => console.error("⚠️ WalletTransaction Delhivery B2B AWB update failed:", e.message));
      return;
    }

    // Neither complete nor failed yet — still processing on Delhivery's
    // side. Check again later instead of leaving the order stuck at
    // "Booked" forever if this was the last scheduled check and the
    // webhook never fires.
    console.log(`[Delhivery B2B] job ${jobId} status "${rawStatus}" not yet final (attempt ${attempt}/${MANIFEST_STATUS_MAX_ATTEMPTS}).`);
    if (attempt < MANIFEST_STATUS_MAX_ATTEMPTS) {
      setTimeout(
        () => getDelhiveryB2BShipmentDetailsInternal(jobId, attempt + 1),
        MANIFEST_STATUS_RETRY_DELAY_MS
      );
    } else {
      console.warn(`[Delhivery B2B] job ${jobId} still not final after ${MANIFEST_STATUS_MAX_ATTEMPTS} checks — relying on webhook or manual reconciliation.`);
    }
  } catch (err) {
    console.error("Delhivery B2B async check error:", err.message);
  }
};

// Cancels the shipment outright by LR number — per Delhivery's own docs:
// "Clients can choose to cancel the shipment altogether so that it does not
// even get picked up from the client warehouse location." Only valid once
// an LRN exists (order.lrn, set when the manifest job resolves), and only
// while the shipment is in one of: Manifested, In Transit, Pending, Open,
// Scheduled — Delhivery rejects the call otherwise. Verified live against
// the real API (DELETE {LTL host}/lrn/cancel/<lrn>) — the docs at
// one.delhivery.com are a JS SPA with no scrapable content, so this was
// confirmed the same way as the rest of this file's endpoints: found in the
// docs site's own compiled JS chunk, then verified with a real request.
const cancelDelhiveryShipmentB2B = async (lrn, courierServiceName) => {
  try {
    const token = await refreshToken(courierServiceName);
    const response = await axios.delete(`${BASE_URL}/lrn/cancel/${lrn}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    // console.log("b2b delhivery tracking",response.data)
    if (response.data?.success === false) {
      return { success: false, message: response.data?.error?.message || "Delhivery shipment cancellation failed" };
    }
    return { success: true, data: response.data };
  } catch (error) {
    return {
      success: false,
      message:
        error.response?.data?.error?.message ||
        error.response?.data?.message ||
        error.message,
    };
  }
};
// cancelDelhiveryShipmentB2B("315097809","Delhivery Surface 20KG")

// Cancels a scheduled pickup slot without cancelling the underlying
// shipment (e.g. to reschedule) — DELETE {LTL host}/pickup_requests/{pickup_id},
// verified live. Not currently wired into the main cancel-order flow since
// pickup_id isn't persisted on the order anywhere yet, and
// cancelDelhiveryShipmentB2B above already achieves "don't pick this up" by
// cancelling the shipment itself. Exported for when a dedicated
// reschedule-pickup flow needs it.
const cancelDelhiveryPickupB2B = async (pickupId, courierServiceName) => {
  try {
    const token = await refreshToken(courierServiceName);
    const response = await axios.delete(`${BASE_URL}/pickup_requests/${pickupId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.data?.success === false) {
      return { success: false, message: response.data?.error?.message || "Delhivery pickup cancellation failed" };
    }
    return { success: true, data: response.data };
  } catch (error) {
    return {
      success: false,
      message:
        error.response?.data?.error?.message ||
        error.response?.data?.message ||
        error.message,
    };
  }
};

// Fetches the current tracking status for one B2B shipment by LR number —
// GET {LTL host}/lrn/track?lrnum=<lrn>. Found the same way as the cancel
// endpoints above (docs site's own compiled JS chunk, shipment-tracking.*.js).
// Response shape confirmed live: {success, request_id, data: {lrnum,
// status, mcount, wbns: [{status, location, wbn, scan_remark,
// scan_timestamp, manifested_date}]}} for an active shipment, or
// {success, request_id, data: "For LR ..., Shipment has been cancelled..."}
// (data as a plain string) after a cancellation — see
// refreshDelhiveryB2BTracking in tracking.controller.js for how both are
// handled. A fake LRN returns a clean
// {success:false, error:{code:404, message:"Data not found."}}.
const trackDelhiveryB2BShipmentInternal = async (lrn, courierServiceName) => {
  const token = await refreshToken(courierServiceName);
  const response = await axios.get(`${BASE_URL}/lrn/track`, {
    params: { lrnum: lrn },
    headers: { Authorization: `Bearer ${token}` },
  });
  return response.data;
};

const createDelhiveryPickupRequest = async (order) => {
  try {
    const token = await refreshToken(order.courierServiceName || order.provider);

    const packageCount =
      order.B2BPackageDetails?.packages?.reduce(
        (sum, pkg) => sum + Number(pkg.noOfBox || 0),
        0
      ) || 1;

    const response = await axios.post(
      `${BASE_URL}/pickup_requests/`,
      {
        client_warehouse: order.pickupAddress?.contactName,
        pickup_date: new Date().toISOString().split("T")[0],
        start_time: "05:00:00",
        expected_package_count: packageCount,
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    return {
      success: true,
      provider: "delhivery",
      orderId: order._id,
      data: response.data,
    };
  } catch (error) {
    return {
      success: false,
      provider: "delhivery",
      orderId: order._id,
      error: error?.response?.data || error.message,
    };
  }
};

const delhiveryManifestCallback = async (req, res) => {
  try {
    /* ================================
       🔐 AUTH VALIDATION
    ================================= */
    const expectedAuth = `Bearer ${process.env.DELHIVERY_WEBHOOK_SECRET || process.env.DELHIVERY_WEBHOOK_TOKEN}`;
    if (req.headers.authorization !== expectedAuth) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const payload = req.body;

    const order = await Order.findOne({
      manifestJobId: payload.job_id,
    });

    if (!order) return res.json({ success: true });

    // This webhook's payload shape has never actually been observed live
    // (unlike the async fallback's GET /manifest response, which turned
    // out to use "Complete"/lrnum/waybills/master_waybill instead of the
    // originally-assumed SUCCESS/lrn/awbs) — normalizing status
    // case-insensitively and accepting both field-name conventions
    // defensively so this doesn't silently no-op the same way if
    // Delhivery's webhook push turns out to use the same real shape.
    const normalizedPayloadStatus = String(payload.status || "").toUpperCase();
    const payloadIsComplete = normalizedPayloadStatus === "COMPLETE" || normalizedPayloadStatus === "COMPLETED" || normalizedPayloadStatus === "SUCCESS";
    const payloadIsFailed = normalizedPayloadStatus.includes("FAIL") || normalizedPayloadStatus.includes("ERROR") || normalizedPayloadStatus.includes("REJECT");

    /* ================================
       ❌ FAILED → REFUND
    ================================= */
    if (payloadIsFailed) {
      if (order.walletDeducted) {
        // This webhook and the async fallback
        // (getDelhiveryB2BShipmentDetailsInternal) can both observe the
        // same failed job and race to refund it — this conditional
        // findOneAndUpdate makes "is this still unrefunded" and "claim it"
        // one atomic step, so only whichever caller runs it first actually
        // refunds; see the identical fix there for the full reasoning.
        const claimedOrder = await Order.findOneAndUpdate(
          { _id: order._id, walletRefunded: { $ne: true } },
          {
            $set: { status: "Cancelled", walletRefunded: true },
            $push: {
              tracking: {
                status: "Cancelled",
                Instructions: payload.error || "Delhivery manifest failed",
                StatusLocation: order.pickupAddress?.city || "N/A",
                StatusDateTime: new Date(Date.now() + 5.5 * 60 * 60 * 1000),
              },
            },
          },
          { new: true }
        );

        if (claimedOrder) {
          const refundAmount = Number(claimedOrder.totalFreightCharges);
          const refundUser = await User.findById(claimedOrder.userId).select("Wallet");
          const refundedWallet = await Wallet.findByIdAndUpdate(
            refundUser.Wallet,
            { $inc: { balance: refundAmount } },
            { new: true }
          );

          await WalletTransaction.create([{
            walletId: refundUser.Wallet,
            category: "credit",
            channelOrderId: claimedOrder.orderId,
            amount: refundAmount,
            balanceAfterTransaction: refundedWallet.balance,
            description: "Freight Charges Received",
            date: new Date(),
          }]);
        }
      }

      return res.json({ success: true });
    }

    /* ================================
       ✅ SUCCESS → SAVE LR + AWBs
    ================================= */
    // Webhooks can be redelivered by the provider — skip if this order was
    // already marked Ready To Ship (e.g. by a prior delivery of this same
    // webhook, or by the async fallback) so we don't push duplicate
    // tracking entries.
    if (payloadIsComplete && !(order.awb_number && order.status === "Ready To Ship")) {
      const payloadAwbList = payload.waybills || payload.awbs || [];
      const payloadAwb = payload.master_waybill || payloadAwbList[0] || null;
      await Order.findByIdAndUpdate(order._id, {
        $set: {
          lrn: payload.lrnum || payload.lrn,
          awb_number: payloadAwb,
          child_awb_numbers: payloadAwbList,
          status: "Ready To Ship",
        },
        $push: {
          tracking: {
            status: "Ready To Ship",
            Instructions: "LR & AWB generated by Delhivery",
            StatusLocation: order.pickupAddress?.city || "N/A",
            StatusDateTime: new Date(Date.now() + 5.5 * 60 * 60 * 1000),
          },
        },
      });

      const user = await User.findById(order.userId).select("Wallet");
      await WalletTransaction.updateOne(
        {
          walletId: user.Wallet,
          channelOrderId: order.orderId,
          category: "debit"
        },
        {
          $set: {
            awb_number: payloadAwb
          }
        }
      ).catch(e => console.error("⚠️ WalletTransaction B2B AWB update failed:", e.message));
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Delhivery Callback Error:", err.message);
    res.json({ success: true });
  }
};

// Was hitting `${DELHIVERY_URL}/b2b/api/v1/pincode/serviceability/?o_pin=&d_pin=`
// — DELHIVERY_URL is Delhivery's Express tracking portal (track.delhivery.com),
// not the LTL/B2B API host, and that path doesn't exist there at all (404,
// confirmed live). This silently made every B2B Delhivery pincode "not
// serviceable" — the catch block swallowed the 404 and just returned false.
// The real B2B API takes one pincode + weight per call (BASE_URL =
// DEL_URL = ltl-clients-api.delhivery.com), so pickup and delivery are
// checked separately and both must be serviceable for the route to be.
const checkDelhiveryPincode = async (pincode, weight, accessToken) => {
  const response = await axios.get(
    `${BASE_URL}/pincode-service/${pincode}`,
    {
      params: { weight },
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    }
  );
  const rows = response.data?.data?.pincode_serviceability_data || [];
  // console.log("delhivery serviceabilty",rows)
  return rows.length > 0;
};

const checkDelhiveryServiceability = async ({ order, packages }) => {
  try {
    const accessToken = await refreshToken(order.courierServiceName || order.provider);
    if (!accessToken) {
      throw new Error("Delhivery access token missing");
    }

    const pickupPincode = order.pickupAddress.pinCode;
    const deliveryPincode = order.receiverAddress.pinCode;

    const totalWeight =
      Number(order.B2BPackageDetails?.applicableWeight) ||
      (packages || []).reduce(
        (sum, p) => sum + (Number(p.noOfBox) || 0) * (Number(p.weightPerBox) || 0),
        0
      ) ||
      1;

    const [pickupServiceable, deliveryServiceable] = await Promise.all([
      checkDelhiveryPincode(pickupPincode, totalWeight, accessToken),
      checkDelhiveryPincode(deliveryPincode, totalWeight, accessToken),
    ]);

    return pickupServiceable && deliveryServiceable;
  } catch (error) {
    console.error(
      "Delhivery Serviceability Error:",
      error.response?.data || error.message
    );
    return false;
  }
};

module.exports = {
  createDelhiveryB2BShipment,
  createDelhiveryPickupRequest,
  delhiveryManifestCallback,
  checkDelhiveryServiceability,
  cancelDelhiveryShipmentB2B,
  cancelDelhiveryPickupB2B,
  trackDelhiveryB2BShipmentInternal,
  getDelhiveryB2BShipmentDetailsInternal,
};
