const webhookRouter = require('express').Router();
const {DelhiveryWebhook,ShreeMarutiWebhook,DTDCWebhook,AmazonShippingWebhook}=require("./webhook.controller")

webhookRouter.post('/delhivery', DelhiveryWebhook);
webhookRouter.post("/shree-maruti",ShreeMarutiWebhook);
webhookRouter.post("/dtdc",DTDCWebhook);
webhookRouter.post("/amazon-shipping",AmazonShippingWebhook);

module.exports = webhookRouter;