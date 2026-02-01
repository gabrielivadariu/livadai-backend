const mongoose = require("mongoose");
const Notification = require("../models/notification.model");
const { sendPushNotification } = require("./push.controller");

const CHAT_PUSH_THROTTLE_MS = 5 * 60 * 1000;
const ATTENDANCE_PUSH_THROTTLE_MS = 24 * 60 * 60 * 1000;

const normalizeId = (value) => {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (value._id) return value._id.toString();
  if (value.id) return value.id.toString();
  return value.toString ? value.toString() : null;
};

const shouldThrottleChatPush = async ({ user, data }) => {
  const bookingId = normalizeId(data?.bookingId);
  if (!bookingId) return false;
  const since = new Date(Date.now() - CHAT_PUSH_THROTTLE_MS);
  const orClauses = [{ "data.bookingId": bookingId }];
  if (mongoose.Types.ObjectId.isValid(bookingId)) {
    orClauses.push({ "data.bookingId": new mongoose.Types.ObjectId(bookingId) });
  }
  const recent = await Notification.findOne({
    user,
    type: "MESSAGE_NEW",
    createdAt: { $gte: since },
    $or: orClauses,
  })
    .select("_id")
    .lean();
  return !!recent;
};

const shouldThrottleAttendancePush = async ({ user, data }) => {
  const bookingId = normalizeId(data?.bookingId);
  if (!bookingId) return false;
  const since = new Date(Date.now() - ATTENDANCE_PUSH_THROTTLE_MS);
  const orClauses = [{ "data.bookingId": bookingId }];
  if (mongoose.Types.ObjectId.isValid(bookingId)) {
    orClauses.push({ "data.bookingId": new mongoose.Types.ObjectId(bookingId) });
  }
  const recent = await Notification.findOne({
    user,
    type: "ATTENDANCE_REQUIRED",
    createdAt: { $gte: since },
    $or: orClauses,
  })
    .select("_id")
    .lean();
  return !!recent;
};

const createNotification = async ({ user, type, title, message, data = {}, push = true }) => {
  if (!user || !type || !title || !message) return null;
  try {
    const notif = await Notification.create({ user, type, title, message, data });
    let shouldPush = !!push;
    if (!push) {
      console.debug("push skipped: push disabled", { type, user: normalizeId(user) });
    }
    if (shouldPush && type === "MESSAGE_NEW") {
      const throttled = await shouldThrottleChatPush({ user, data });
      if (throttled) {
        shouldPush = false;
        console.debug("push skipped: chat throttled", { type, user: normalizeId(user), bookingId: normalizeId(data?.bookingId) });
      }
    }
    if (shouldPush && type === "ATTENDANCE_REQUIRED") {
      const throttled = await shouldThrottleAttendancePush({ user, data });
      if (throttled) {
        shouldPush = false;
        console.debug("push skipped: attendance throttled", { type, user: normalizeId(user), bookingId: normalizeId(data?.bookingId) });
      }
    }
    if (shouldPush) {
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
