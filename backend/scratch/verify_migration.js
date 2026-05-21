require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../config/database");
const Wallet = require("../models/wallet");
const WalletTransaction = require("../models/WalletTransaction.model");

async function runVerification() {
  console.log("🚀 Starting Wallet Transactions Count Verification...");
  
  try {
    // 1. Connect to Database
    await connectDB();
    console.log("📡 Connected to database.");

    // 2. Aggregate legacy transactions count
    const oldTotalRes = await Wallet.aggregate([
      {
        $project: {
          count: { $size: { $ifNull: ["$transactions", []] } }
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: "$count" }
        }
      }
    ]);
    
    const legacyTotal = oldTotalRes[0] ? oldTotalRes[0].total : 0;
    
    // 3. Count standalone collection transactions
    const newTotal = await WalletTransaction.countDocuments();
    
    console.log(`\n📊 Count Verification Summary:`);
    console.log(`   - Legacy Embedded Transactions Total: ${legacyTotal}`);
    console.log(`   - Standalone WalletTransaction Collection Total: ${newTotal}`);
    
    if (legacyTotal === newTotal) {
      console.log(`\n✅ SUCCESS: Counts match perfectly!`);
    } else {
      console.log(`\n⚠️ WARNING: Counts do not match. Historical migration script should be run.`);
    }

  } catch (error) {
    console.error("❌ Verification failed with error:", error);
  } finally {
    // 4. Close the database connection
    await mongoose.connection.close();
    console.log("🔌 Database connection closed.");
    process.exit(0);
  }
}

runVerification();
