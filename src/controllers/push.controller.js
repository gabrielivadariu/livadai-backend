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
      return { ok: false, reason: "missing_token" };
    }
    const isValidToken = /^Expo(nent)?PushToken\[/.test(token);
    if (!isValidToken) {
      console.debug("push skipped: invalid token", { userId, tokenPrefix: token.slice(0, 20) });
      return { ok: false, reason: "invalid_token" };
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
        sound: "default",
        priority: "high",
        data,
      }),
    });
    const payload = await res.json().catch(() => null);
    const status = payload?.data?.status || payload?.data?.[0]?.status;
    if (!res.ok || status === "error") {
      const errorData = payload?.data || payload;
      console.error("sendPushNotification failed", { status: res.status, errorData });
      return { ok: false, status: res.status, error: errorData };
    }
    return { ok: true, status: res.status, data: payload?.data || payload };
  } catch (err) {
    console.error("sendPushNotification error", err);
    return { ok: false, reason: "exception", error: err?.message || String(err) };
  }
};

const sendTestPush = async (req, res) => {
  try {
    const result = await sendPushNotification({
      userId: req.user.id,
      title: "LIVADAI test",
      body: "Notificare de test. Dacă vezi asta, push-urile sunt OK.",
      data: { type: "TEST_PUSH" },
    });
    return res.json({ success: true, result });
  } catch (err) {
    console.error("sendTestPush error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

const debugPushToken = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("expoPushToken");
    return res.json({
      hasToken: !!user?.expoPushToken,
      token: user?.expoPushToken || null,
    });
  } catch (err) {
    console.error("debugPushToken error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

module.exports = { savePushToken, sendPushNotification, sendTestPush, debugPushToken };
