const Booking = require("../models/booking.model");
const Message = require("../models/message.model");
const Experience = require("../models/experience.model");
const User = require("../models/user.model");
const { createNotification } = require("./notifications.controller");

const isParticipant = (booking, userId) => {
  return (
    booking.explorer.toString() === userId || booking.host.toString() === userId
  );
};

const ensureChatAllowed = (booking) => {
  return ["PAID", "COMPLETED", "DEPOSIT_PAID"].includes(booking.status);
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

    if (!isParticipant(booking, req.user.id)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    if (!ensureChatAllowed(booking)) {
      return res
        .status(403)
        .json({ message: "Chat is available only after payment." });
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

    if (!isParticipant(booking, req.user.id)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    if (!ensureChatAllowed(booking)) {
      return res
        .status(403)
        .json({ message: "Chat is available only after payment." });
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
    const bookings = await Booking.find({
      status: { $in: ["PAID", "COMPLETED", "DEPOSIT_PAID", "PENDING_ATTENDANCE"] },
      $or: [{ explorer: req.user.id }, { host: req.user.id }],
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

module.exports = { listMessages, sendMessage, listConversations };
