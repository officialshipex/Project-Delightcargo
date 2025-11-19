const DELHIVERY_WEBHOOK_TOKEN=process.env.DELHIVERY_WEBHOOK_TOKEN
const SHREEMARUTI_WEBHOOK_TOKEN=process.env.SHREEMARUTI_WEBHOOK_TOKEN
const DTDC_WEBHOOK_TOKEN=process.env.DTDC_WEBHOOK_TOKEN
const AMAZON_SHIPPING_WEBHOOK_TOKEN=process.env.AMAZON_SHIPPING_WEBHOOK_TOKEN
const DelhiveryWebhook = async (req, res) => {
  const token = req.headers.authorization;

  if (token !== `Bearer ${DELHIVERY_WEBHOOK_TOKEN}`) {
    return res.status(401).send("Unauthorized");
  }

  console.log("Webhook Scan Received:", req.body);
  res.status(200).send("OK");
};

const ShreeMarutiWebhook = async (req, res) => {
  const token = req.headers.authorization;
  // console.log("token",token)

  // if (token !== SHREEMARUTI_WEBHOOK_TOKEN) {
  //   return res.status(401).send("Unauthorized");
  // }

  console.log("Webhook Scan Received:", req.body);
  res.status(200).send("OK");
};

const DTDCWebhook = async (req, res) => {
  const token = req.headers.authorization;
  console.log("token",token)

  if (token !== DTDC_WEBHOOK_TOKEN) {
    return res.status(401).send("Unauthorized");
  }

  console.log("Webhook Scan Received:", req.body);
  res.status(200).send("OK");
};

const AmazonShippingWebhook = async (req, res) => {
  const token = req.headers.authorization;
  console.log("token",token)

  if (token !== AMAZON_SHIPPING_WEBHOOK_TOKEN) {
    return res.status(401).send("Unauthorized");
  }

  console.log("Webhook Scan Received:", req.body);
  res.status(200).send("OK");
};
module.exports = { DelhiveryWebhook,ShreeMarutiWebhook,DTDCWebhook,AmazonShippingWebhook };
