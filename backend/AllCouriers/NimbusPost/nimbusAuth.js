/**
 * NimbusPost Auth Token Helper
 * Fetches email/password from the AllCourier DB record (courierProvider: 'NimbusPost').
 * Falls back to NIMBUS_GMAIL / NIMBUS_PASS env vars if DB record not found.
 * Caches the JWT token for 23 hours.
 */

const axios = require('axios');

const BASE_URL = process.env.NIMBUSPOST_URL || 'https://api.nimbuspost.com/v1';

let _cachedToken = null;
let _tokenExpiry = null;

/**
 * Resolves NimbusPost credentials from DB first, then falls back to .env
 */
const getNimbusCredentials = async () => {
    try {
        const AllCourier = require('../../models/AllCourierSchema');
        const record = await AllCourier.findOne({ courierProvider: 'NimbusPost' }).select('email password').lean();
        if (record && record.email && record.password) {
            return { email: record.email, password: record.password };
        }
    } catch (err) {
        console.warn('[NimbusPost] Could not fetch credentials from DB, falling back to .env:', err.message);
    }

    // Fallback to environment variables
    const email = process.env.NIMBUS_GMAIL;
    const password = process.env.NIMBUS_PASS;
    if (!email || !password) {
        throw new Error('NimbusPost credentials not found in DB or .env (NIMBUS_GMAIL / NIMBUS_PASS)');
    }
    return { email, password };
};

/**
 * Returns a valid NimbusPost Bearer token.
 * Fetches a new one from /users/login if cached token is missing or expired.
 */
const getNimbusToken = async () => {
    if (_cachedToken && _tokenExpiry && Date.now() < _tokenExpiry) {
        return _cachedToken;
    }

    const { email, password } = await getNimbusCredentials();

    const response = await axios.post(
        `${BASE_URL}/users/login`,
        { email, password },
        { headers: { 'content-type': 'application/json' } }
    );

    if (!response.data?.status) {
        throw new Error(`NimbusPost login failed: ${response.data?.message || 'Unknown error'}`);
    }

    // Token is in response.data.data
    _cachedToken = response.data.data;
    // Cache for 23 hours (tokens are typically valid for 24h)
    _tokenExpiry = Date.now() + 23 * 60 * 60 * 1000;

    console.log('[NimbusPost] New auth token fetched and cached.');
    return _cachedToken;
};

/**
 * Returns headers for a JSON POST/PUT request with Bearer token auth.
 */
const getNimbusJsonHeaders = async () => {
    const token = await getNimbusToken();
    return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
    };
};

/**
 * Returns headers for a GET request with Bearer token auth (no Content-Type).
 */
const getNimbusGetHeaders = async () => {
    const token = await getNimbusToken();
    return {
        'Authorization': `Bearer ${token}`,
    };
};

/**
 * Clears cached token — call this if a request returns 401 to force re-login.
 */
const clearNimbusToken = () => {
    _cachedToken = null;
    _tokenExpiry = null;
};

// Create a custom axios instance for NimbusPost to transparently handle token refreshes
const nimbusAxios = axios.create();

nimbusAxios.interceptors.response.use(
    async (response) => {
        // If NimbusPost returns status: false with an invalid/missing token message, retry the request
        if (response.data && response.data.status === false && 
            (response.data.message === 'Missing or invalid Token in request' || 
             response.data.message === 'invalid token' ||
             String(response.data.message).toLowerCase().includes('token'))) {
            
            console.warn('[NimbusPost] Invalid token detected in response. Clearing cache and retrying...');
            clearNimbusToken();
            
            const config = response.config;
            const isJson = config.headers['Content-Type'] === 'application/json' || (config.data && typeof config.data === 'object');
            const freshHeaders = isJson ? await getNimbusJsonHeaders() : await getNimbusGetHeaders();
            
            config.headers = {
                ...config.headers,
                ...freshHeaders
            };
            
            // Retry the request using the main axios instance to avoid infinite loop
            return axios(config);
        }
        return response;
    },
    (error) => {
        return Promise.reject(error);
    }
);

module.exports = { getNimbusToken, getNimbusJsonHeaders, getNimbusGetHeaders, clearNimbusToken, nimbusAxios };

