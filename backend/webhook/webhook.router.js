const webhookRouter = require('express').Router();
const {DelhiveryWebhook}=require("./webhook.controller")

webhookRouter.post('/delhivery', DelhiveryWebhook);

module.exports = webhookRouter;