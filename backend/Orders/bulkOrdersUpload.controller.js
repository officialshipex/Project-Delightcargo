const fs = require("fs");
const csvParser = require("csv-parser");
const Order = require("../models/newOrder.model.js");
const ExcelJS = require("exceljs");
const path = require("path");
const xlsx = require("xlsx");
const File = require("../model/bulkOrderFiles.model.js");
const bulkOrdersExcel = require("../model/bulkOrdersExcel.model.js");
const bulkOrdersCSV = require("../model/bulkOrderCSV.model.js");
const PickupAddress = require("../models/pickupAddress.model.js");

const downloadSampleExcel = async (req, res) => {
  try {
    // Create a new workbook and add a worksheet
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Sample Bulk Order");

    // Define headers
    worksheet.columns = [
      { header: "*Receiver Contact Name", key: "contactName", width: 30 },
      { header: "*Receiver Email", key: "email", width: 30 },
      { header: "*Receiver Phone Number", key: "phoneNumber", width: 30 },
      { header: "*Receiver Address", key: "address", width: 40 },
      { header: "*Receiver Pin Code", key: "pinCode", width: 15 },
      { header: "*Receiver City", key: "city", width: 25 },
      { header: "*Receiver State", key: "state", width: 25 },
      { header: "*Dead Weight (kg)", key: "deadWeight", width: 20 },
      { header: "*Length (cm)", key: "length", width: 20 },
      { header: "*Width (cm)", key: "width", width: 20 },
      { header: "*Height (cm)", key: "height", width: 20 },

      // Mandatory Product 1
      { header: "*Product 1 Name", key: "product1_name", width: 30 },
      { header: "*Product 1 SKU", key: "product1_sku", width: 30 },
      { header: "*Product 1 Quantity", key: "product1_quantity", width: 30 },
      { header: "*Product 1 Unit Price", key: "product1_price", width: 30 },

      // Optional Product 2
      { header: "Product 2 Name (Optional)", key: "product2_name", width: 30 },
      { header: "Product 2 SKU (Optional)", key: "product2_sku", width: 30 },
      {
        header: "Product 2 Quantity (Optional)",
        key: "product2_quantity",
        width: 30,
      },
      {
        header: "Product 2 Unit Price (Optional)",
        key: "product2_price",
        width: 30,
      },

      // Optional Product 3
      { header: "Product 3 Name (Optional)", key: "product3_name", width: 30 },
      { header: "Product 3 SKU (Optional)", key: "product3_sku", width: 30 },
      {
        header: "Product 3 Quantity (Optional)",
        key: "product3_quantity",
        width: 30,
      },
      {
        header: "Product 3 Unit Price (Optional)",
        key: "product3_price",
        width: 30,
      },

      { header: "*Method (COD/Prepaid)", key: "method", width: 20 },
      {
        header:"Reseller Name (Optional)",key:"resellerName", width:40,
      },
      {
        header:"GSTIN (Optional)",key:"gstin",width:40
      },{
        header:"GST E-Waybill Number",key:"ewaybill",width:40
      }
    ];

    // Add a sample row with mandatory product 1 and optional products
    worksheet.addRow({
      contactName: "John Doe",
      email: "johndoe@example.com",
      phoneNumber: "9876543210",
      address: "123 Main Street, New York",
      pinCode: "10001",
      city: "New York",
      state: "NY",

      deadWeight: 2, // in kg
      length: 30, // in cm
      width: 20, // in cm
      height: 10, // in cm

      // Mandatory Product 1
      product1_name: "Wireless Headphones",
      product1_sku: "WH123",
      product1_quantity: 1,
      product1_price: 50,

      // Optional Product 2 (provided)
      product2_name: "Smartwatch",
      product2_sku: "SW456",
      product2_quantity: 2,
      product2_price: 150,

      // Optional Product 3 (empty)
      product3_name: "",
      product3_sku: "",
      product3_quantity: "",
      product3_price: "",

      method: "Prepaid",
      resellerName:"",
      gstin:"",
      ewaybill:""
    });

    // Format the header row
    worksheet.getRow(1).eachCell((cell) => {
      cell.alignment = { vertical: "middle", horizontal: "center" };
      cell.font = { bold: true }; // Make headers bold
    });

    // Set response headers for file download
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", "attachment; filename=sample.xlsx");

    // Write workbook to response stream
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error("Error generating Excel file:", error);
    res
      .status(500)
      .json({ error: "Error generating Excel file", details: error.message });
  }
};

// Helper function to read CSV file and store in database
function parseCSV(filePath, fileData) {
  return new Promise((resolve, reject) => {
    const orders = [];
    fs.createReadStream(filePath)
      .pipe(csv())
      .on("data", async (row) => {
        // orders.push(row);
        try {
          const order = new bulkOrdersCSV({
            fileId: fileData._id,
            orderId: row["*Order Id"],
            orderDate: row["Order Date as dd-mm-yyyy hh:MM"] || null,
            channel: row["*Channel"],
            paymentMethod: row["*Payment Method(COD/Prepaid)"],
            customer: {
              firstName: row["*Customer First Name"],
              lastName: row["Customer Last Name"] || "",
              email: row["Email (Optional)"] || "",
              mobile: row["*Customer Mobile"],
              alternateMobile: row["Customer Alternate Mobile"] || "",
            },
            shippingAddress: {
              line1: row["*Shipping Address Line 1"],
              line2: row["Shipping Address Line 2"] || "",
              country: row["*Shipping Address Country"],
              state: row["*Shipping Address State"],
              city: row["*Shipping Address City"],
              postcode: row["*Shipping Address Postcode"],
            },
            billingAddress: {
              line1: row["Billing Address Line 1"] || "",
              line2: row["Billing Address Line 2"] || "",
              country: row["Billing Address Country"] || "",
              state: row["Billing Address State"] || "",
              city: row["Billing Address City"] || "",
              postcode: row["Billing Address Postcode"] || "",
            },
            orderDetails: {
              masterSKU: row["*Master SKU"],
              name: row["*Product Name"],
              quantity: parseInt(row["*Product Quantity"]) || 0,
              taxPercentage: parseFloat(row["Tax %"]),
              sellingPrice: parseFloat(
                row["*Selling Price(Per Unit Item, Inclusive of Tax)"]
              ),
              discount: parseFloat(row["Discount(Per Unit Item)"]) || 0,
              shippingCharges: parseFloat(
                row["Shipping Charges(Per Order)"] || 0
              ),
              codCharges: parseFloat(row["COD Charges(Per Order)"] || 0),
              giftWrapCharges: parseFloat(
                row["Gift Wrap Charges(Per Order)"] || 0
              ),
              totalDiscount: parseFloat(row["Total Discount (Per Order)"] || 0),
              dimensions: {
                length: parseFloat(row["*Length (cm)"]),
                breadth: parseFloat(row["*Breadth (cm)"]),
                height: parseFloat(row["*Height (cm)"]),
              },
              weight: parseFloat(row["*Weight Of Shipment(kg)"]),
            },
            sendNotification:
              row["Send Notification(True/False)"].toLowerCase() === "true",
            comment: row["Comment"] || "",
            hsnCode: row["HSN Code"] || "",
            locationId: row["Location Id"] || "",
            resellerName: row["Reseller Name"] || "",
            companyName: row["Company Name"] || "",
            latitude: parseFloat(row["latitude"] || 0),
            longitude: parseFloat(row["longitude"] || 0),
            verifiedOrder: row["Verified Order"] === "1",
            isDocuments: row["Is documents"] || "No",
            orderType: row["Order Type"] || "",
            orderTag: row["Order tag"] || "",
          });
          await order.save();
          console.log(`Imported order: ${order.orderId}`);
        } catch (error) {
          console.error(`Error importing order: ${row["*Order Id"]}`, error);
        }
      })
      .on("end", () => {
        console.log("CSV file successfully processed");
        resolve(orders);
      })
      .on("error", (error) => {
        console.log("CSV Parsing error:", error);
        reject(error);
      });
  });
}

// Helper function to read Excel file (.xlsx, .xls)
function parseExcel(filePath) {
  const workbook = xlsx.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const data = xlsx.utils.sheet_to_json(sheet);
  return data;
}

const bulkOrder = async (req, res) => {
  try {
    const userID = req.user._id;
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    // Save file metadata
    const fileData = new File({
      filename: req.file.filename,
      date: new Date(),
      status: "Processing",
    });
    await fileData.save();

    // Determine the file extension
    const fileExtension = path.extname(req.file.originalname).toLowerCase();
    let orders = [];

    // Parse the file based on its extension
    if (fileExtension === ".csv") {
      // orders = await parseCSV(req.file.path, fileData);
    } else if (fileExtension === ".xlsx" || fileExtension === ".xls") {
      orders = await parseExcel(req.file.path);
    } else {
      return res.status(400).json({ error: "Unsupported file format" });
    }

    // Validation: Check if file contains data
    if (!orders || orders.length === 0) {
      return res
        .status(400)
        .json({ error: "The uploaded file is empty or contains invalid data" });
    }

    // Find user's default pickup address from the DB
    const defaultAddress = await PickupAddress.findOne({
      userId: userID,
      isPrimary: true,
    });

    const defaultPickupAddress = defaultAddress
      ? {
          contactName: defaultAddress.pickupAddress.contactName,
          email: defaultAddress.pickupAddress.email,
          phoneNumber: defaultAddress.pickupAddress.phoneNumber,
          address: defaultAddress.pickupAddress.address,
          pinCode: defaultAddress.pickupAddress.pinCode,
          city: defaultAddress.pickupAddress.city,
          state: defaultAddress.pickupAddress.state,
        }
      : {
          contactName: "Default Name",
          email: "default@example.com",
          phoneNumber: "0000000000",
          address: "Default Address",
          pinCode: "000000",
          city: "Default City",
          state: "Default State",
        };

    const orderDocs = await Promise.all(
      orders.map(async (row, index) => {
        const deadWeight = parseFloat(row["*Dead Weight (kg)"] || 0);
        const volumetricWeight =
          (parseFloat(row["*Length (cm)"] || 0) *
            parseFloat(row["*Width (cm)"] || 0) *
            parseFloat(row["*Height (cm)"] || 0)) /
          5000;
        const applicableWeight = Math.max(deadWeight, volumetricWeight);

        let orderId;
        let isUnique = false;

        while (!isUnique) {
          orderId = Math.floor(100000 + Math.random() * 900000); // Generates a random six-digit number
          const existingOrder = await Order.findOne({ orderId });
          if (!existingOrder) {
            isUnique = true;
          }
        }
        const compositeOrderId = `${req.user._id}-${orderId}`;
        const product1Quantity = parseInt(row["*Product 1 Quantity"] || 1);
        const product2Quantity = parseInt(
          row["Product 2 Quantity (Optional)"] || 1
        );
        const product3Quantity = parseInt(
          row["Product 3 Quantity (Optional)"] || 1
        );

        const product1Price = parseFloat(row["*Product 1 Unit Price"] || 0);
        const product2Price = parseFloat(
          row["Product 2 Unit Price (Optional)"] || 0
        );
        const product3Price = parseFloat(
          row["Product 3 Unit Price (Optional)"] || 0
        );

        const totalAmount =
          product1Quantity * product1Price +
          product2Quantity * product2Price +
          product3Quantity * product3Price;

        return {
          userId: userID,
          orderId: orderId,
          pickupAddress: defaultPickupAddress,
          receiverAddress: {
            contactName: row["*Receiver Contact Name"] || "Unknown",
            email: row["*Receiver Email"] || "unknown@example.com",
            phoneNumber: row["*Receiver Phone Number"] || "0000000000",
            address: row["*Receiver Address"] || "No Address",
            pinCode: row["*Receiver Pin Code"] || "000000",
            city: row["*Receiver City"] || "Unknown City",
            state: row["*Receiver State"] || "Unknown State",
          },
          paymentDetails: {
            method: (row["*Method (COD/Prepaid)"] || "Prepaid").trim(), // ✅ remove spaces
            amount: totalAmount,
          },

          productDetails: [
            {
              id: 1,
              name: row["*Product 1 Name"] || "Unknown Product",
              sku: row["*Product 1 SKU"] || "UNKNOWN_SKU",
              quantity: product1Quantity,
              unitPrice: product1Price,
            },
            ...(row["Product 2 Name (Optional)"]
              ? [
                  {
                    id: 2,
                    name: row["Product 2 Name (Optional)"],
                    sku: row["Product 2 SKU (Optional)"] || "UNKNOWN_SKU",
                    quantity: product2Quantity,
                    unitPrice: product2Price,
                  },
                ]
              : []),
            ...(row["Product 3 Name (Optional)"]
              ? [
                  {
                    id: 3,
                    name: row["Product 3 Name (Optional)"],
                    sku: row["Product 3 SKU (Optional)"] || "UNKNOWN_SKU",
                    quantity: product3Quantity,
                    unitPrice: product3Price,
                  },
                ]
              : []),
          ],

          packageDetails: {
            deadWeight,
            applicableWeight,
            volumetricWeight: {
              length: parseFloat(row["*Length (cm)"] || 0),
              width: parseFloat(row["*Width (cm)"] || 0),
              height: parseFloat(row["*Height (cm)"] || 0),
            },
          },
          otherDetails:{
            resellerName:row["Reseller Name (Optional)"],
            gstin:row["GSTIN (Optional)"],
            ewaybill:row["GST E-Waybill Number"]
          },
          channel: "custom",
          compositeOrderId,
          status: "new",
        };
      })
    );

    // Insert all orders in bulk
    await Order.insertMany(orderDocs);

    // Update file metadata
    fileData.status = "Completed";
    fileData.noOfOrders = orderDocs.length;
    fileData.successfullyUploaded = orderDocs.length;
    await fileData.save();

    // Delete uploaded file
    fs.unlink(req.file.path, (err) => {
      if (err) {
        console.error("⚠️ Failed to delete uploaded file:", err);
      } else {
        console.log("🧹 Temporary file deleted:", req.file.path);
      }
    });

    return res.status(200).json({
      message: "Bulk order uploaded successfully",
      file: fileData,
    });
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({ error: "An error occurred while processing the file" });
  }
};

// module.exports = { bulkOrder };

module.exports = { bulkOrder, downloadSampleExcel };
