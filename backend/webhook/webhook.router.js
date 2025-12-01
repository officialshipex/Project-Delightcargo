const webhookRouter = require('express').Router();
// const {DelhiveryWebhook}=require("./webhook.controller")
const {ShreeMarutiWebhook}=require("./ShreeMarutiWebhook.controller")
const {AmazonShippingWebhook}=require("./AmasonShippingWebhook.controller")
const {DTDCWebhook}=require("./DtdcWebhook.controller")
const {DelhiveryWebhook}=require("./DelhiveryWebhook.controller")
const {AmazonShippingNDRWebhook}=require("./NDR/AmazonShippingWebhook.controller")

webhookRouter.post('/delhivery', DelhiveryWebhook);
webhookRouter.post("/shree-maruti",ShreeMarutiWebhook);
webhookRouter.post("/dtdc",DTDCWebhook);
webhookRouter.post("/amazon-shipping",AmazonShippingWebhook);


webhookRouter.post("/amazon-shipping-ndr",AmazonShippingNDRWebhook);

module.exports = webhookRouter;


