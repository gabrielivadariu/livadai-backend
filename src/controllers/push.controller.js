const User = require("../models/user.model");
const fetch = require("node-fetch");

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

const savePushToken = async (req, res) => {
  try {
    const { expoPushToken } = req.body;
    if (!expoPushToken) return res.status(400).json({ message: "expoPushToken required" });

    await User.findByIdAndUpdate(req.user.id, { expoPushToken });
    return res.json({ success: true });
  } catch (err) {
    console.error("savePushToken error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

const sendPushNotification = async ({ userId, title, body, data = {} }) => {
  if (!userId) return;
  try {
    const user = await User.findById(userId).select("expoPushToken");
    const token = user?.expoPushToken;
    if (!token) {
      console.debug("push skipped: missing token", { userId });
      return;
    }
    const isValidToken = /^Expo(nent)?PushToken\[/.test(token);
    if (!isValidToken) {
      console.debug("push skipped: invalid token", { userId, tokenPrefix: token.slice(0, 20) });
      return;
    }

    const res = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Accept-encoding": "gzip, deflate",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to: token,
        title,
        body,
        data,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error("sendPushNotification failed", { status: res.status, text });
    }
  } catch (err) {
    console.error("sendPushNotification error", err);
  }
};

module.exports = { savePushToken, sendPushNotification };
