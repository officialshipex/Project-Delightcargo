const ZoneMapping = require("../../models/zoneMatrix.model");
const { findByPincode } = require("../../pincodeLoader");
const User =require("../../../models/User.model")

/**
 * 🔐 Admin Access Check (Reusable)
 */
const checkAdminAccess = async (req, res) => {
  const userId = req.user?._id;

  if (!userId) {
    res.status(401).json({ message: "Unauthorized" });
    return null;
  }

  const user = await User.findById(userId);

  if (!user || !user.isAdmin || !user.adminTab) {
    res.status(403).json({ message: "Access denied" });
    return null;
  }

  return user;
};

/**
 * GET all zones with locations
 */
exports.getAll = async (req, res) => {
  try {
    const admin = await checkAdminAccess(req, res);
    if (!admin) return;
    const data = await ZoneMapping.find().sort({ createdAt: -1 });
    res.json(data);
  } catch (err) {
    console.error("getAll error:", err);
    res.status(500).json({ message: "Failed to fetch zones" });
  }
};

/**
 * ADD location(s) to a zone
 * - Creates zone if not exists
 * - Prevents duplicate locations globally
 */
exports.addLocation = async (req, res) => {
  try {
    const admin = await checkAdminAccess(req, res);
    if (!admin) return;
    const { zone, locations } = req.body;

    if (!zone || !Array.isArray(locations) || locations.length === 0) {
      return res.status(400).json({ message: "Invalid payload" });
    }

    // normalize names
    const cleanLocations = locations.map((l) => ({
      name: l.name.trim(),
    }));

    // 🔍 Check if any location already exists in another zone
    const existing = await ZoneMapping.findOne({
      "locations.name": { $in: cleanLocations.map((l) => l.name) },
    });

    if (existing) {
      return res.status(409).json({
        message: `"${
          existing.locations.find((l) =>
            cleanLocations.some((c) => c.name === l.name)
          )?.name
        }" already mapped in zone ${existing.zone}`,
      });
    }

    // ✅ Add locations to zone (create zone if not exists)
    const updated = await ZoneMapping.findOneAndUpdate(
      { zone },
      {
        $addToSet: {
          locations: { $each: cleanLocations }, // prevents duplicates inside same zone
        },
      },
      { new: true, upsert: true }
    );

    res.status(201).json(updated);
  } catch (err) {
    console.error("addLocation error:", err);
    res.status(500).json({ message: "Failed to add location" });
  }
};

/**
 * REMOVE single location from zone
 */
exports.removeLocation = async (req, res) => {
  try {
    const admin = await checkAdminAccess(req, res);
    if (!admin) return;
    const { zone, name } = req.body;

    if (!zone || !name) {
      return res.status(400).json({ message: "Invalid payload" });
    }

    await ZoneMapping.updateOne(
      { zone },
      { $pull: { locations: { name: name.trim() } } }
    );

    res.json({ success: true });
  } catch (err) {
    console.error("removeLocation error:", err);
    res.status(500).json({ message: "Failed to remove location" });
  }
};

/**
 * DELETE entire zone
 */
exports.removeZone = async (req, res) => {
  try {
    const admin = await checkAdminAccess(req, res);
    if (!admin) return;
    const { id } = req.params;
    await ZoneMapping.findByIdAndDelete(id);
    res.json({ success: true });
  } catch (err) {
    console.error("removeZone error:", err);
    res.status(500).json({ message: "Failed to delete zone" });
  }
};

/**
 * PINCODE LOOKUP (unchanged)
 */
exports.lookupPincode = async (req, res) => {
  try {
    const admin = await checkAdminAccess(req, res);
    if (!admin) return;
    const { pincode } = req.query;

    if (!pincode) {
      return res.json({ found: false });
    }

    const data = await findByPincode(pincode);

    if (!data) {
      return res.json({ found: false });
    }

    res.json({
      found: true,
      city: data.city,
      state: data.state,
    });
  } catch (err) {
    console.error("lookupPincode error:", err);
    res.status(500).json({ found: false });
  }
};
