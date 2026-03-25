const EPDMap = require("../models/EPDMap.model");
const Courier = require("../models/AllCourierSchema");
const CourierService = require("../models/CourierService.Schema");

const getAllCourier = async (req, res) => {
  try {
    const courier = await Courier.find();
    res.json(courier);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const getAllCourierService = async (req, res) => {
  try {
    const courierService = await CourierService.find();
    res.json(courierService);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const getAllEpdMap = async (req, res) => {
  try {
    const maps = await EPDMap.find();
    res.json(maps);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const addEPD = async (req, res) => {
  try {
    const map = new EPDMap(req.body);
    await map.save();
    res.status(201).json(map);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

const updateEPD = async (req, res) => {
  try {
    const { id } = req.params;
    const map = await EPDMap.findByIdAndUpdate(id, req.body, { new: true });
    res.json(map);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

const deleteEPD = async (req, res) => {
  try {
    const { id } = req.params;
    await EPDMap.findByIdAndDelete(id);
    res.json({ message: "EPD Map deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

module.exports = { getAllCourier, getAllCourierService, getAllEpdMap, addEPD, updateEPD, deleteEPD };
