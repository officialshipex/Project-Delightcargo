const Announcement = require("../models/Announcement.model");
const mongoose = require("mongoose");

// Create Announcement
exports.createAnnouncement = async (req, res) => {
  try {
    const {
      message,
      enabled,
      targetAudience,
      selectedUsers,
      disableType,
      automatedDuration,
      automatedDisableUntil,
    } = req.body;

    let disableUntilDate = null;
    if (disableType === "automated") {
      if (automatedDuration === "1h") {
        disableUntilDate = new Date(Date.now() + 60 * 60 * 1000);
      } else if (automatedDuration === "1d") {
        disableUntilDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
      } else if (automatedDuration === "5d") {
        disableUntilDate = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
      } else if (automatedDuration === "custom") {
        disableUntilDate = new Date(automatedDisableUntil);
      }
    }

    const announcement = new Announcement({
      message,
      enabled,
      targetAudience,
      selectedUsers: targetAudience === "selected" ? selectedUsers : [],
      disableType,
      automatedDuration,
      automatedDisableUntil: disableUntilDate,
    });

    await announcement.save();
    res.status(201).json({ success: true, announcement });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Get All Announcements (Admin)
exports.getAllAnnouncements = async (req, res) => {
  try {
    const announcements = await Announcement.find()
      .populate("selectedUsers", "name email")
      .sort({ createdAt: -1 });
    res.status(200).json({ success: true, announcements });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Update Announcement
exports.updateAnnouncement = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      message,
      enabled,
      targetAudience,
      selectedUsers,
      disableType,
      automatedDuration,
      automatedDisableUntil,
    } = req.body;

    let disableUntilDate = null;
    if (disableType === "automated") {
      if (automatedDuration === "1h") {
        disableUntilDate = new Date(Date.now() + 60 * 60 * 1000);
      } else if (automatedDuration === "1d") {
        disableUntilDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
      } else if (automatedDuration === "5d") {
        disableUntilDate = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
      } else if (automatedDuration === "custom") {
        disableUntilDate = new Date(automatedDisableUntil);
      }
    }

    const announcement = await Announcement.findByIdAndUpdate(
      id,
      {
        message,
        enabled,
        targetAudience,
        selectedUsers: targetAudience === "selected" ? selectedUsers : [],
        disableType,
        automatedDuration,
        automatedDisableUntil: disableUntilDate,
      },
      { new: true }
    );

    if (!announcement) {
      return res.status(404).json({ success: false, message: "Announcement not found" });
    }

    res.status(200).json({ success: true, announcement });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Delete Announcement
exports.deleteAnnouncement = async (req, res) => {
  try {
    const { id } = req.params;
    await Announcement.findByIdAndDelete(id);
    res.status(200).json({ success: true, message: "Announcement deleted successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Get Active Announcement for User
exports.getActiveAnnouncement = async (req, res) => {
  try {
    const userId = new mongoose.Types.ObjectId(req.user._id);
    const now = new Date();

    const announcements = await Announcement.find({
      enabled: true,
      $and: [
        {
          $or: [
            { targetAudience: "all" },
            { 
              $and: [
                { targetAudience: "selected" },
                { selectedUsers: userId }
              ]
            }
          ]
        },
        {
          $or: [
            { disableType: "manual" },
            { automatedDisableUntil: { $gt: now } }
          ]
        }
      ]
    }).sort({ createdAt: -1 });

    res.status(200).json({ success: true, announcements });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
