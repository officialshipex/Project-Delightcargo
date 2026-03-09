const AllCourier = require("../../../models/AllCourierSchema");

const BOXDLOGISTICS_EMAIL = process.env.BOXDLOGISTICS_EMAIL;
const BOXDLOGISTICS_PASSWORD = process.env.BOXDLOGISTICS_PASSWORD;

const saveBoxdLogistics = async (req, res) => {
    const { email, password } = req.body.credentials;
    const { courierName, courierProvider, CODDays, status } = req.body;
// console.log(email, password);
    // Validate if the provided credentials match the expected ones
    if (BOXDLOGISTICS_EMAIL !== email || BOXDLOGISTICS_PASSWORD !== password) {
        return res
            .status(400)
            .json({ message: "Unauthorized access. Invalid credentials." });
    }

    const courierData = {
        courierName,
        courierProvider,
        CODDays,
        status,
    };

    try {
        const newCourier = new AllCourier(courierData);
        await newCourier.save();

        return res.status(201).json({
            message: "Courier successfully added.",
            courier: newCourier,
        });
    } catch (error) {
        return res.status(500).json({
            message: "Failed to add courier.",
            error: error.message,
        });
    }
};

module.exports = { saveBoxdLogistics };
