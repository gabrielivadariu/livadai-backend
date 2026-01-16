const Notification = require("../models/notification.model");
const { sendPushNotification } = require("./push.controller");

const createNotification = async ({ user, type, title, message, data = {}, push = true }) => {
  if (!user || !type || !title || !message) return null;
  try {
    const notif = await Notification.create({ user, type, title, message, data });
    if (push) {
      sendPushNotification({
        userId: user,
        title,
        body: message,
        data: { type, ...data },
      });
    }
    return notif;
  } catch (err) {
    console.error("createNotification error", err);
    return null;
  }
};

const listNotifications = async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const skip = (Number(page) - 1) * Number(limit);
    const items = await Notification.find({ user: req.user.id })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit));
    return res.json(items);
  } catch (err) {
    console.error("listNotifications error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

const markRead = async (req, res) => {
  try {
    const ids = req.body.ids || [];
    if (!Array.isArray(ids) || !ids.length) return res.json({ success: true });
    await Notification.updateMany({ _id: { $in: ids }, user: req.user.id }, { $set: { isRead: true } });
    return res.json({ success: true });
  } catch (err) {
    console.error("markRead error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

const markAllRead = async (req, res) => {
  try {
    await Notification.updateMany({ user: req.user.id, isRead: false }, { $set: { isRead: true } });
    return res.json({ success: true });
  } catch (err) {
    console.error("markAllRead error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

const unreadCount = async (req, res) => {
  try {
    const count = await Notification.countDocuments({ user: req.user.id, isRead: false });
    return res.json({ count });
  } catch (err) {
    console.error("unreadCount error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

module.exports = { createNotification, listNotifications, markRead, markAllRead, unreadCount };
