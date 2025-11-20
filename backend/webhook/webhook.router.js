const webhookRouter = require('express').Router();
const {DelhiveryWebhook,DTDCWebhook,AmazonShippingWebhook}=require("./webhook.controller")
const {ShreeMarutiWebhook}=require("./ShreeMarutiWebhook.controller")

webhookRouter.post('/delhivery', DelhiveryWebhook);
webhookRouter.post("/shree-maruti",ShreeMarutiWebhook);
webhookRouter.post("/dtdc",DTDCWebhook);
webhookRouter.post("/amazon-shipping",AmazonShippingWebhook);

module.exports = webhookRouter;