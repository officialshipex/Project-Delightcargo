const WareHouse = require("../models/wareHouse.model");
const User = require("../models/User.model");
const { addPickupLocation, getAllPickupLocations } = require("../AllCouriers/ShipRocket/Courier/couriers.controller");
const{createClientWarehouse}=require("../AllCouriers/Delhivery/Courier/couriers.controller");

const createWareHouse = async (req, res) => {
  try {
    if (!req.body.formData || !req.body.userId) {
      return res.status(400).json({ message: "Missing required fields." });
    }

    const data = req.body.formData;
    const userId = req.body.userId;

    const currentUser = await User.findById(userId);
    if (!currentUser) {
      return res.status(404).json({ message: "User not found." });
    }

    const existingWareHouse = await WareHouse.findOne({
      addressLine1: data.addressLine1,
      city: data.city,
      state: data.state,
    });

    if (existingWareHouse) {
      return res.status(400).json({ message: "Warehouse with the same name and address already exists." });
    }

    try {
      let locations = await getAllPickupLocations();
      const existingLocation = locations.find(location => 
        location.pickup_location === data.warehouseName || 
        (location.address === data.addressLine1 && location.city === data.city)
      );
      
      if (existingLocation) {
        console.log("EXISTING LOCATION",existingLocation);
        return res.status(400).json({
          message: "Pickup location with the same name or address already exists."
        });
      }
    } catch (pickupError) {
      return res.status(500).json({ message: "Error checking pickup location.", error: pickupError.message });
    }

    try {
      await addPickupLocation(data, currentUser.email);
      await createClientWarehouse(data);
    } catch (pickupError) {
      return res.status(500).json({ message: "Error creating pickup location.", error: pickupError.message });
    }

    const newWareHouse = new WareHouse(data);
    const wh = await newWareHouse.save();

    currentUser.wareHouse.push(wh._id);
    await currentUser.save();

    res.status(201).json({
      message: "Warehouse has been successfully saved.",
      warehouse: wh,
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
};


module.exports = { createWareHouse };

