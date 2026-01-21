const Booking = require("../models/booking.model");
const Message = require("../models/message.model");
const Experience = require("../models/experience.model");
const User = require("../models/user.model");
const { createNotification } = require("./notifications.controller");
const Notification = require("../models/notification.model");
const mongoose = require("mongoose");

const normalizeId = (value) => {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (value._id) return value._id.toString();
  if (value.id) return value.id.toString();
  return value.toString ? value.toString() : null;
};

const isParticipant = (booking, userId) => {
  const explorerId = normalizeId(booking.explorer);
  const hostId = normalizeId(booking.host);
  return explorerId === userId || hostId === userId;
};

const CHAT_STATUSES = new Set([
  "PAID",
  "DEPOSIT_PAID",
  "PENDING_ATTENDANCE",
  "COMPLETED",
  "AUTO_COMPLETED",
  "NO_SHOW",
  "DISPUTED",
]);

const isChatArchived = (booking) => {
  if (!booking?.chatArchivedAt) return false;
  const archivedAt = new Date(booking.chatArchivedAt);
  return !Number.isNaN(archivedAt.getTime()) && archivedAt <= new Date();
};

const ensureChatAllowed = (booking, isAdmin = false) => {
  if (!booking) return false;
  if (!isAdmin && isChatArchived(booking)) return false;
  return CHAT_STATUSES.has(booking.status);
};

const maskContactInfo = (text) => {
  if (!text) return text;
  // basic email regex and phone patterns
  const emailRegex = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  const phoneRegex = /(\+?\d[\d\s\-]{7,}\d)/g; // 8+ digits with optional + and separators
  return text.replace(emailRegex, "[contact hidden]").replace(phoneRegex, "[contact hidden]");
};

const listMessages = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const booking = await Booking.findById(bookingId);
    if (!booking) return res.status(404).json({ message: "Booking not found" });

    const isAdmin = req.user?.role === "ADMIN";
    if (!isAdmin && !isParticipant(booking, req.user.id)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    if (!ensureChatAllowed(booking, isAdmin)) {
      return res
        .status(403)
        .json({ message: isChatArchived(booking) ? "Chat archived." : "Chat is available only after payment." });
    }

    const messages = await Message.find({ booking: bookingId })
      .sort({ createdAt: 1 })
      .populate("sender", "name displayName profilePhoto avatar")
      .select("sender message createdAt");

    const normalized = messages.map((m) => ({
      _id: m._id,
      booking: m.booking,
      sender: m.sender,
      senderId: m.sender?._id?.toString() || m.sender?.toString(),
      senderProfile: m.sender
        ? {
            name: m.sender.displayName || m.sender.name,
            profileImage: m.sender.profilePhoto || m.sender.avatar,
          }
        : undefined,
      message: m.message,
      createdAt: m.createdAt,
    }));

    return res.json(normalized);
  } catch (err) {
    console.error("List messages error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

const sendMessage = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const { message } = req.body;

    const booking = await Booking.findById(bookingId);
    if (!booking) return res.status(404).json({ message: "Booking not found" });

    const isAdmin = req.user?.role === "ADMIN";
    if (!isParticipant(booking, req.user.id)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    if (!ensureChatAllowed(booking, isAdmin)) {
      return res
        .status(403)
        .json({ message: isChatArchived(booking) ? "Chat archived." : "Chat is available only after payment." });
    }

    if (!message || !message.trim()) {
      return res.status(400).json({ message: "Message text required" });
    }

    const filtered = maskContactInfo(message.trim());

    const created = await Message.create({
      booking: bookingId,
      sender: req.user.id,
      message: filtered,
    });

    // Notify the other participant
    try {
      const otherUserId = booking.explorer.toString() === req.user.id ? booking.host : booking.explorer;
      if (otherUserId) {
        const sender = await User.findById(req.user.id);
        const experience = await Experience.findById(booking.experience);
        await createNotification({
          user: otherUserId,
          type: "MESSAGE_NEW",
          title: "New message",
          message: `${sender?.name || "Someone"} sent you a message about "${experience?.title || "experience"}".`,
          data: {
            bookingId: booking._id,
            activityId: booking.experience,
            activityTitle: experience?.title,
            senderName: sender?.name || "Someone",
            messagePreview: filtered.slice(0, 120),
          },
        });
      }
    } catch (err) {
      console.error("Notify message error", err);
    }

    const senderData = await User.findById(req.user.id).select("name displayName profilePhoto avatar");
    return res.status(201).json({
      _id: created._id,
      booking: created.booking,
      sender: created.sender,
      senderId: created.sender.toString(),
      senderProfile: {
        name: senderData?.displayName || senderData?.name,
        profileImage: senderData?.profilePhoto || senderData?.avatar,
      },
      message: created.message,
      createdAt: created.createdAt,
    });
  } catch (err) {
    console.error("Send message error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

const listConversations = async (req, res) => {
  try {
    // bookings where user is explorer or host and paid/completed
    const now = new Date();
    const bookings = await Booking.find({
      status: { $in: Array.from(CHAT_STATUSES) },
      $and: [
        { $or: [{ explorer: req.user.id }, { host: req.user.id }] },
        { $or: [{ chatArchivedAt: { $exists: false } }, { chatArchivedAt: null }, { chatArchivedAt: { $gt: now } }] },
      ],
    }).populate("experience", "title");

    const results = [];

    for (const booking of bookings) {
      const lastMsg = await Message.findOne({ booking: booking._id })
        .sort({ createdAt: -1 })
        .select("message createdAt sender");
      if (!lastMsg) continue;

      const otherUserId =
        booking.explorer.toString() === req.user.id
          ? booking.host
          : booking.explorer;
      const otherUser = await User.findById(otherUserId).select("name displayName profilePhoto avatar");

      results.push({
        bookingId: booking._id,
        experienceTitle: booking.experience?.title,
        lastMessage: lastMsg.message,
        lastMessageAt: lastMsg.createdAt,
        otherUser: otherUser
          ? { _id: otherUser._id, name: otherUser.displayName || otherUser.name, avatar: otherUser.profilePhoto || otherUser.avatar }
          : undefined,
      });
    }

    return res.json(results);
  } catch (err) {
    console.error("List conversations error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

const unreadMessagesCount = async (req, res) => {
  try {
    const count = await Notification.countDocuments({
      user: req.user.id,
      type: "MESSAGE_NEW",
      isRead: false,
    });
    return res.json({ count });
  } catch (err) {
    console.error("Unread messages count error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

const markMessagesRead = async (req, res) => {
  try {
    const { bookingId } = req.body || {};
    const query = { user: req.user.id, type: "MESSAGE_NEW", isRead: false };
    if (bookingId) {
      const objId = mongoose.Types.ObjectId.isValid(bookingId) ? new mongoose.Types.ObjectId(bookingId) : null;
      query["data.bookingId"] = objId ? { $in: [bookingId, objId] } : bookingId;
    }
    await Notification.updateMany(query, { $set: { isRead: true } });
    return res.json({ success: true });
  } catch (err) {
    console.error("Mark messages read error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

module.exports = { listMessages, sendMessage, listConversations, unreadMessagesCount, markMessagesRead };
