require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../config/database");
const Wallet = require("../models/wallet");
const WalletTransaction = require("../models/WalletTransaction.model");

async function runMigration() {
  console.log("🚀 Starting Wallet Transactions Historical Migration...");
  
  try {
    // 1. Connect to Database
    await connectDB();
    console.log("📡 Connected to database. Scanning wallets...");

    // 2. Fetch all wallets using a cursor to prevent memory overload
    const walletCursor = Wallet.find({}).cursor();
    let totalWalletsProcessed = 0;
    let totalTransactionsMigrated = 0;

    for (let wallet = await walletCursor.next(); wallet != null; wallet = await walletCursor.next()) {
      totalWalletsProcessed++;
      const walletId = wallet._id;
      const transactions = wallet.transactions || [];

      if (transactions.length === 0) {
        console.log(`[${totalWalletsProcessed}] Wallet ${walletId}: No transactions to migrate.`);
        continue;
      }

      console.log(`[${totalWalletsProcessed}] Wallet ${walletId}: Found ${transactions.length} embedded transactions. Checking for duplicates...`);

      // 3. Fetch all existing transactions in WalletTransaction for this wallet to make the migration idempotent
      const existingTx = await WalletTransaction.find({ walletId }).lean();
      
      // Create a set of unique identifier strings for existing transactions
      // Unique signature: date_amount_category_awb
      const existingSignatures = new Set(
        existingTx.map(tx => {
          const dateMs = tx.date ? new Date(tx.date).getTime() : 0;
          const awb = tx.awb_number || "";
          return `${dateMs}_${tx.amount}_${tx.category}_${awb}`;
        })
      );

      // 4. Filter out transactions that have already been migrated
      const transactionsToMigrate = [];
      for (const tx of transactions) {
        const dateMs = tx.date ? new Date(tx.date).getTime() : 0;
        const awb = tx.awb_number || "";
        const signature = `${dateMs}_${tx.amount}_${tx.category}_${awb}`;

        if (!existingSignatures.has(signature)) {
          transactionsToMigrate.push({
            walletId: walletId,
            channelOrderId: tx.channelOrderId || null,
            category: tx.category,
            amount: tx.amount,
            balanceAfterTransaction: tx.balanceAfterTransaction,
            date: tx.date || new Date(),
            awb_number: tx.awb_number || "",
            description: tx.description || "",
            priceBreakup: tx.priceBreakup || {},
            transactionStatus: "Success"
          });
        }
      }

      // 5. Bulk insert if there are any new transactions to migrate for this wallet
      if (transactionsToMigrate.length > 0) {
        console.log(`  -> Migrating ${transactionsToMigrate.length} new transactions for Wallet ${walletId}...`);
        await WalletTransaction.insertMany(transactionsToMigrate);
        totalTransactionsMigrated += transactionsToMigrate.length;
      } else {
        console.log(`  -> All ${transactions.length} transactions already migrated for Wallet ${walletId}.`);
      }
    }

    console.log(`\n🎉 Historical Migration Completed Successfully!`);
    console.log(`📊 Summary:`);
    console.log(`   - Total Wallets Scanned: ${totalWalletsProcessed}`);
    console.log(`   - Total New Transactions Migrated: ${totalTransactionsMigrated}`);

  } catch (error) {
    console.error("❌ Migration failed with error:", error);
  } finally {
    // 6. Always close the database connection
    await mongoose.connection.close();
    console.log("🔌 Database connection closed.");
    process.exit(0);
  }
}

runMigration();
