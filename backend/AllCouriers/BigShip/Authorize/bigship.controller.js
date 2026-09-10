const axios = require("axios");
const AllCourier = require("../../../models/AllCourierSchema");
const PickupAddress = require("../../../models/pickupAddress.model");

// BigShip serves both B2C and B2B off a single account (segment_type on each
// call differentiates them), so this module is shared by both integrations
// rather than duplicated the way B2C Shiprocket and B2B Shiprocket Cargo are.
const BASE_URL = process.env.BIGSHIP_URL || "https://api.bigship.direct";
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // refresh 5 min before expiry

// Temporary diagnostic — BigShip's 3-step booking flow makes several
// mandatory sequential HTTP calls that can't be parallelized (each needs the
// previous step's output), and their own response times have been slow
// during testing. This logs exactly where the time goes on the next real
// booking, instead of guessing. Safe to remove once the real bottleneck is
// identified from a live run.
const timedBigShipCall = async (label, fn) => {
  const start = Date.now();
  try {
    return await fn();
  } finally {
    console.log(`[BigShip timing] ${label}: ${Date.now() - start}ms`);
  }
};

const getBigShipCredentials = async () => {
  const courier =
    (await AllCourier.findOne({ courierProvider: "BigShip", status: "Enable" })) ||
    (await AllCourier.findOne({ courierProvider: "BigShip" }));

  return {
    courier,
    username: courier?.email || process.env.BIGSHIP_USERNAME,
    password: courier?.password || process.env.BIGSHIP_PASSWORD,
    accessKey: courier?.accessKey || process.env.BIGSHIP_ACCESS_KEY,
  };
};

const loginBigShip = async ({ username, password, accessKey }) => {
  const response = await axios.post(
    `${BASE_URL}/api/outbound/login`,
    { username, password, access_key: accessKey },
    { headers: { "Content-Type": "application/json" }, timeout: 10000 }
  );

  if (!response.data?.status || !response.data?.data?.token) {
    throw new Error(response.data?.message || "BigShip login failed");
  }

  return response.data.data; // { token, tokenExpiringAt, ... }
};

// Token is cached on the courier record itself (not just in-memory) so it
// survives a server restart instead of re-logging-in every time — mirrors
// the DB-backed pattern used for B2B Shiprocket Cargo's refresh token.
const getBigShipToken = async () => {
  const { courier, username, password, accessKey } = await getBigShipCredentials();

  if (!username || !password || !accessKey) {
    throw new Error("BigShip credentials missing — add a BigShip courier account first.");
  }

  const cachedToken = courier?.bigshipToken;
  const cachedExpiresAt = courier?.bigshipTokenExpiringAt
    ? new Date(courier.bigshipTokenExpiringAt).getTime()
    : 0;

  if (cachedToken && Date.now() < cachedExpiresAt - TOKEN_REFRESH_BUFFER_MS) {
    return cachedToken;
  }

  const data = await timedBigShipCall("login (token refresh)", () => loginBigShip({ username, password, accessKey }));

  if (courier) {
    await AllCourier.updateOne(
      { _id: courier._id },
      { $set: { bigshipToken: data.token, bigshipTokenExpiringAt: data.tokenExpiringAt } }
    );
  }

  return data.token;
};

const saveBigShip = async (req, res) => {
  const { username, password, accessKey } = req.body.credentials || {};
  const { courierName, courierProvider, CODDays, status } = req.body;

  if (!username || !password || !accessKey) {
    return res.status(400).json({ message: "Username, password and access key are required." });
  }

  let loginData;
  try {
    loginData = await loginBigShip({ username, password, accessKey });
  } catch (error) {
    return res.status(400).json({
      message: "BigShip authentication failed.",
      error: error.response?.data?.message || error.message,
    });
  }

  try {
    const newCourier = new AllCourier({
      courierName,
      courierProvider,
      CODDays,
      status,
      email: username,
      password,
      accessKey,
      bigshipToken: loginData.token,
      bigshipTokenExpiringAt: loginData.tokenExpiringAt,
    });
    await newCourier.save();
    return res.status(201).json({
      message: "BigShip courier successfully added.",
      courier: newCourier,
    });
  } catch (error) {
    return res.status(500).json({
      message: "Failed to save BigShip courier.",
      error: error.message,
    });
  }
};

const bigShipRequest = async (method, path, { data, params } = {}) => {
  const token = await getBigShipToken();
  return timedBigShipCall(`${method.toUpperCase()} ${path}`, () =>
    axios({
      method,
      url: `${BASE_URL}${path}`,
      data,
      params,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      timeout: 15000,
    })
  );
};

// Delightcargo pickup addresses aren't pre-registered anywhere else (Shiprocket
// Cargo and Delhivery both accept a full inline address per order) — BigShip
// is the first provider that needs a persistent remote warehouse ID, so this
// follows the same "cache the provider's remote id on the pickup address doc"
// pattern already used for smartshipHubId/zipypostHubId/boxdLogisticsWarehouseId.
const getOrCreateBigShipWarehouse = async (pickupAddressDoc) => {
  if (pickupAddressDoc.bigshipWarehouseId) {
    return pickupAddressDoc.bigshipWarehouseId;
  }

  const addr = pickupAddressDoc.pickupAddress;

  // Dedup check first — avoid creating a duplicate warehouse if one already
  // exists on BigShip's side for this contact (e.g. re-added address, or a
  // warehouse created outside this app).
  try {
    const listRes = await bigShipRequest("get", "/api/outbound/get-warehouse-list", {
      params: {
        page: "1",
        perPage: "10",
        segment_type: "local",
        filter_type: "warehouse_phone",
        filter_value: addr.phoneNumber,
      },
    });
    const existing = listRes.data?.data?.warehouse?.find(
      (w) => String(w.pincode) === String(addr.pinCode)
    );
    if (existing) {
      await PickupAddress.updateOne(
        { _id: pickupAddressDoc._id },
        { $set: { bigshipWarehouseId: String(existing.warehouseId) } }
      );
      return String(existing.warehouseId);
    }
  } catch (error) {
    console.error("BigShip: warehouse list lookup failed, will attempt create:", error.response?.data || error.message);
  }

  let createRes;
  try {
    createRes = await bigShipRequest("post", "/api/outbound/save-warehouse-data", {
      data: {
        segment_type: "local",
        // Not in the doc's documented field list for Save Warehouse, but the
        // live API rejects the request without it ("The warehouse name field
        // is required.") — confirmed via a live 422 response, not guessed.
        // A second live 422 then confirmed it must be letters/spaces only (no
        // digits/underscores), so it can't be made unique with a timestamp —
        // just the sanitized contact name, matching what a human would type.
        warehouseName: (addr.contactName || "Warehouse").replace(/[^a-zA-Z\s]/g, "").trim() || "Warehouse",
        warehouseContactPerson: addr.contactName,
        warehouseAddressPhone: addr.phoneNumber,
        warehouseCountry: "India",
        warehouseState: addr.state,
        warehouseCity: addr.city,
        warehousePinCode: addr.pinCode,
        warehouseAddressLine1: addr.address,
        // BigShip requires the landmark field to be 3+ words — Delightcargo's
        // address model has no dedicated landmark field, so build one that
        // reliably clears that minimum instead of passing a single city name.
        warehouseAddressLandMark: `Near ${addr.city}, ${addr.state}`,
      },
    });
  } catch (err) {
    // BigShip's warehouseCity validates against district-level names, not
    // town/post-office names (confirmed live: "Baliapal" rejected, the
    // district "Balasore" accepted, for the same pincode) — our pincode data
    // is town-level, so this can legitimately happen for any pickup address
    // outside a district headquarters. Only a handful of addresses are ever
    // used as pickup points, so surface exactly which field to fix rather
    // than a generic "invalid city" message.
    if (err.response?.data?.errors?.warehouseCity) {
      throw new Error(
        `BigShip rejected the pickup address city "${addr.city}" (PIN ${addr.pinCode}, ${addr.state}). ` +
        `BigShip expects the district name here, not the town/village name — edit this pickup address's ` +
        `city field to its district (e.g. lookup "${addr.pinCode} district" if unsure) and try again.`
      );
    }
    throw new Error(err.response?.data?.message || err.message || "Failed to register BigShip warehouse");
  }

  if (!createRes.data?.status || !createRes.data?.data?.warehouseId) {
    throw new Error(createRes.data?.message || "Failed to register BigShip warehouse");
  }

  const warehouseId = String(createRes.data.data.warehouseId);
  await PickupAddress.updateOne(
    { _id: pickupAddressDoc._id },
    { $set: { bigshipWarehouseId: warehouseId } }
  );
  return warehouseId;
};

module.exports = {
  saveBigShip,
  getBigShipToken,
  getBigShipCredentials,
  bigShipRequest,
  getOrCreateBigShipWarehouse,
  timedBigShipCall,
};
