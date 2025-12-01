const AMAZON_SHIPPING_WEBHOOK_TOKEN=process.env.AMAZON_SHIPPING_WEBHOOK_TOKEN
const AmazonShippingNDRWebhook = async (req, res) => {
  const token = req.headers.authorization;

  if (token !== AMAZON_SHIPPING_WEBHOOK_TOKEN) {
    return res.status(401).send("Unauthorized");
  }

  console.log("Amazon ndr Webhook Scan Received:", req.body);
  res.status(200).send("OK");
};

module.exports = { AmazonShippingNDRWebhook};