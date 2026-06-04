const { Strategy } = require('passport-google-oauth2');
const passport = require('passport');
require('dotenv').config();

const clientID = process.env.CLIENT_ID || process.env.clientID;
const clientSecret = process.env.CLIENT_SECRET;

const config = {
  CLIENT_ID: clientID,
  CLIENT_SECRET: clientSecret,
};

if (!clientID || !clientSecret) {
  console.warn('⚠️ Warning: Google OAuth CLIENT_ID or CLIENT_SECRET is missing in environment variables. Google login will not work.');
}

const AUTH_OPTIONS = {
  callbackURL: '/v1/external/auth/google/callback',
  clientID: clientID || 'dummy-client-id',
  clientSecret: clientSecret || 'dummy-client-secret',
};

async function verifyCallback(accessToken, refreshToken, profile, done) {
  // console.log('Google profile', profile);

  done(null, profile);
}

passport.use(new Strategy(AUTH_OPTIONS, verifyCallback));

// Save the session from the cookie
passport.serializeUser((user, done) => {
  done(null, user.id);
});

// Read the session from the cookie
passport.deserializeUser((user, done) => {
  done(null, user.id);
});

module.exports = passport;
