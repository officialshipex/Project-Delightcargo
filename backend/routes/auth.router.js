const { register, login, googleLogin, googleLoginFail, verifySession, forgetPassword, changePasswordController } = require('../auth/auth.controller');
// const { isAuthorized } = require('../middleware/auth.middleware');  // Commented as per your request
// const passport = require('passport');
const authRouter = require('express').Router();
const passport = require('../config/passwordConfig');
// Import the middleware here, if required
const { isAuthorized } = require('../middleware/auth.middleware');

// Register route - No need for authorization
authRouter.post('/register', register);

// Login route - No need for authorization
authRouter.post('/login', login);
//forgetPassword  route - No need for authorization
authRouter.post("/forgetPassword", forgetPassword);

// Add the Admin change password route
authRouter.post("/changePasswordAdmin", changePasswordController);
// Test route for Google in the backend
// authRouter.get('/', loadAuth) // This is commented as per your request

// Auth route (Google login) - No need for authorization here
authRouter.get('/auth/google',
    passport.authenticate('google', {
        scope: ['email', 'profile'],
    })
);

// Auth Callback route (After successful login with Google)
authRouter.get('/auth/google/callback',
    passport.authenticate('google', { failureRedirect: '/failure', session: false }),
    googleLogin,
);

// Failure route for Google login - No need for authorization here
authRouter.get('/failure', googleLoginFail);

// Verify session route - This might need authorization
authRouter.get('/verify', isAuthorized, verifySession);

// Optionally, you can add more routes here that require authorization
// For example:
// authRouter.get('/protected', isAuthorized, (req, res) => {
//     res.status(200).json({
//         success: true,
//         message: 'This is a protected route',
//     });
// });

module.exports = authRouter;
