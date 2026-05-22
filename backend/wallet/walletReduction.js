const Wallet = require("../models/wallet");
const fetch = require('node-fetch');

const adjustDispute = async (Info, req) => {
    try {
        const id = req.user.wallet;
        const userWallet = await Wallet.findById(id).select("balance");

        if (!userWallet) {
            throw new Error("Wallet not found!");
        }

        const disputeInfo = Info.dispute;

        if (!disputeInfo || !disputeInfo.pickupPincode || !disputeInfo.deliveryPincode) {
            throw new Error("Invalid dispute info provided.");
        }

        const response = await fetch(process.env.RATE_API_URL || 'http://localhost:5000/v1/calculateRate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(disputeInfo),
        });

        const result = await response.json();

        let reduction = 0;
        const serviceMatch = result.find(r => r.courierServiceName === Info.courierServiceName);

        if (serviceMatch) {
            reduction += serviceMatch.forward.totchargesf;
        }

        userWallet.totalAmount -= reduction;
        await userWallet.save();

        return { success: true, message: "Dispute adjusted successfully!" };
    } catch (error) {
        return { success: false, message: error.message };
    }
};

const reduceWallet = async (motion, type, freightCharges, codCharge, req) => {
    try {
        const id = req.user.wallet;
        const userWallet = await Wallet.findById(id).select("balance");

        if (!userWallet) {
            throw new Error("Wallet not found!");
        }

        if (motion === 'forward') {
            userWallet.totalAmount -= freightCharges;
            if (type === 'cod') {
                userWallet.totalAmount -= (codCharge+(codCharge*(18/100)));
            }
        } else if (motion === 'rto') {
            if (type === 'cod') {
                userWallet.totalAmount += codCharge;
            } else if (type === 'prepaid') {
                userWallet.totalAmount -= freightCharges;
            }
        }

        await userWallet.save();
        return { success: true, message: "Wallet updated successfully!" };
    } catch (error) {
        return { success: false, message: error.message };
    }
};

module.exports = { reduceWallet, adjustDispute };


    // let disputeInfo={
    //     pickupPincode: '',
    //     deliveryPincode: '',
    //     weight: '',
    //     length: '',
    //     height: '',
    //     breadth: '',
    //     value: '',
    //     paymentMode: 'cod',
    // };