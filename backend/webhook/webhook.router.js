const webhookRouter = require('express').Router();
const {DelhiveryWebhook,ShreeMarutiWebhook}=require("./webhook.controller")

webhookRouter.post('/delhivery', DelhiveryWebhook);
webhookRouter.post("/shree-maruti",ShreeMarutiWebhook);

module.exports = webhookRouter;