const axios = require("axios");

const BASE_URL = "https://app.splashifypro.in/api";
const API_KEY = process.env.WHATSAPP_API_KEY; // replace with your API key
const PHONE_NUMBER_ID = process.env.WHATSAPP_NUMBER_ID; // replace with your phone number ID

async function sendWhatsAppMessage({
  to,
  type,
  message,
  mediaUrl,
  templateName,
  templateData,
}) {
  try {
    if (!to) throw new Error("Recipient phone number (to) is required.");

    let payload = {
      phoneNoId: PHONE_NUMBER_ID,
      to,
      type,
    };
    // console.log(
    //   "base url:",
    //   BASE_URL,
    //   "api key:",
    //   API_KEY,
    //   "phone number id:",
    //   PHONE_NUMBER_ID
    // );
    // Handle message types
    switch (type) {
      case "text":
        payload.text = message ;
        break;

      case "media":
        if (!mediaUrl)
          throw new Error("mediaUrl is required for media messages.");
        payload.media = { link: mediaUrl };
        break;

      case "template":
        if (!templateName)
          throw new Error("templateName is required for template messages.");
        payload.template = {
          name: templateName,
          language: { code: "en_US" },
          components: templateData || [],
        };
        break;

      default:
        throw new Error("Invalid message type.");
    }

    // Send message
    const response = await axios.post(
      `${BASE_URL}/v2/whatsapp-business/messages`,
      payload,
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
        },
      }
    );

    console.log("✅ WhatsApp Message Sent:", response.data);
    return response.data;
  } catch (error) {
    console.error(
      "❌ Error sending WhatsApp message:",
      error.response?.data || error.message
    );
    // throw error;
  }
}

// sendWhatsAppMessage({
//   to: "9668649450",
//   type: "text",
//   message: "Hello from Shipex WhatsApp API!",
// });
