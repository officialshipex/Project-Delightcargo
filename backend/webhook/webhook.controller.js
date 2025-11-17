const WEBHOOK_TOKEN=process.env.WEBHOOK_TOKEN
const DelhiveryWebhook = async (req, res) => {
  const token = req.headers.authorization;

  if (token !== `Bearer ${WEBHOOK_TOKEN}`) {
    return res.status(401).send("Unauthorized");
  }

  console.log("Webhook Scan Received:", req.body);
  res.status(200).send("OK");
};
module.exports = { DelhiveryWebhook };
