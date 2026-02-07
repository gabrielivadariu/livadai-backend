const User = require("../models/user.model");
const fetch = require("node-fetch");

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

const savePushToken = async (req, res) => {
  try {
    const { expoPushToken } = req.body;
    if (!expoPushToken) return res.status(400).json({ message: "expoPushToken required" });
    const tokenPrefix = expoPushToken.slice(0, 20);
    console.log("[push] save token", { userId: req.user.id, tokenPrefix });
    await User.findByIdAndUpdate(req.user.id, { expoPushToken });
    return res.json({ success: true, tokenPrefix });
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

    const payloadToSend = {
      to: token,
      title,
      body,
      sound: "default",
      priority: "high",
      data,
    };
    console.log("[push] send", { userId, tokenPrefix: token.slice(0, 20), payload: { title, body, data } });
    const res = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Accept-encoding": "gzip, deflate",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payloadToSend),
    });
    const payload = await res.json().catch(() => null);
    const status = payload?.data?.status || payload?.data?.[0]?.status;
    if (!res.ok || status === "error") {
      const errorData = payload?.data || payload;
      console.error("sendPushNotification failed", { status: res.status, errorData });
      return { ok: false, status: res.status, error: errorData };
    }
    console.log("[push] expo response", payload?.data || payload);
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
    let receipt = null;
    try {
      const ticket = result?.data?.[0] || result?.data;
      const receiptId = ticket?.id;
      if (receiptId) {
        const receiptRes = await fetch("https://exp.host/--/api/v2/push/getReceipts", {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Accept-encoding": "gzip, deflate",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ids: [receiptId] }),
        });
        const receiptPayload = await receiptRes.json().catch(() => null);
        receipt = receiptPayload?.data?.[receiptId] || receiptPayload;
        console.log("[push] receipt", { receiptId, receipt });
      }
    } catch (_e) {
      receipt = null;
    }
    return res.json({ success: true, result, receipt });
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
