require("dotenv").config();
const connection = require("./config/database");
const app = require("./server");

const PORT = process.env.PORT || 5000;
// console.log("hello")
(async function () {
  try {
    await connection();
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`✅ Server running on http://65.1.105.160:${PORT}`);
    });
  } catch (err) {
    console.error("❌ Database connection error:", err);
  }
})();