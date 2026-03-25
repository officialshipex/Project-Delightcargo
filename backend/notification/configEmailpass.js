require("dotenv").config(); // Load environment variables

const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  host: "smtp.zeptomail.in", 
  port: 587,
  secure: false,
  auth: {
    user: "emailapikey",
    pass: process.env.NOTIFICATION_PASS,
    // pass: "PHtE6r0JEe/ijmUm+hUA4PC/RMamMYJ8q+1leQQRtNsUD6cHH00A/9AilDTj/h8jAPdFFPKTz4JvuL3Otr2MI2rlMmkeWGqyqK3sx/VYSPOZsbq6x00VsFsafkDZUoXncN9v0CTXudvZNA==",
  },
});


// const transporter = nodemailer.createTransport({
//   host: 'smtp.sendgrid.net',
//   port: 587,
//   auth: { user: 'apikey', pass: process.env.SENDGRID_API_KEY }
// });

module.exports = transporter; 




