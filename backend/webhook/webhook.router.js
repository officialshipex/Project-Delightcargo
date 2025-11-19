const webhookRouter = require('express').Router();
const {DelhiveryWebhook,ShreeMarutiWebhook,DTDCWebhook}=require("./webhook.controller")

webhookRouter.post('/delhivery', DelhiveryWebhook);
webhookRouter.post("/shree-maruti",ShreeMarutiWebhook);
webhookRouter.post("/dtdc",DTDCWebhook);

module.exports = webhookRouter;