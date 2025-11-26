const DELHIVERY_WEBHOOK_TOKEN=process.env.DELHIVERY_WEBHOOK_TOKEN
const DelhiveryWebhook = async (req, res) => {
  const token = req.headers.authorization;
console.log("Delhivery Webhook Token:", token)
  if (token !== `Bearer ${DELHIVERY_WEBHOOK_TOKEN}`) {
    return res.status(401).send("Unauthorized");
  }

  console.log("Webhook Scan Received from Delhivery:", req.body);
  res.status(200).send("OK");
};

module.exports = { DelhiveryWebhook };