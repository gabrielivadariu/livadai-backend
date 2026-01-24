const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../models/user.model");
const crypto = require("crypto");
const { sendEmail } = require("../utils/mailer");
const {
  buildEmailVerificationEmail,
  buildWelcomeEmail,
  buildPasswordResetEmail,
  buildPasswordChangedEmail,
} = require("../utils/emailTemplates");
const { validatePasswordStrength } = require("../utils/passwordPolicy");

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;
const loginAttempts = new Map();

const getClientIp = (req) => {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.ip || req.connection?.remoteAddress || "unknown";
};

const getLoginKey = (req, email) => `${getClientIp(req)}|${String(email || "").toLowerCase()}`;

const isLoginBlocked = (key) => {
  const entry = loginAttempts.get(key);
  return !!(entry && entry.blockedUntil && entry.blockedUntil > Date.now());
};

const recordLoginFailure = (key) => {
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || now - entry.firstAttempt > LOGIN_WINDOW_MS) {
    const next = { count: 1, firstAttempt: now, blockedUntil: null };
    loginAttempts.set(key, next);
    return false;
  }
  const nextCount = entry.count + 1;
  const blocked = nextCount >= LOGIN_MAX_ATTEMPTS;
  loginAttempts.set(key, {
    count: nextCount,
    firstAttempt: entry.firstAttempt,
    blockedUntil: blocked ? now + LOGIN_WINDOW_MS : null,
  });
  return blocked;
};

const clearLoginAttempts = (key) => {
  loginAttempts.delete(key);
};

const signToken = (user) => {
  return jwt.sign(
    {
      userId: user._id,
      role: user.role,
      tokenVersion: user.tokenVersion || 0,
    },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );
};

const sendEmailVerification = async (user) => {
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  user.emailVerificationCode = otp;
  user.emailVerificationExpires = new Date(Date.now() + 15 * 60 * 1000);
  user.emailVerificationAttempts = 0;
  await user.save();
  const html = buildEmailVerificationEmail({ code: otp, expiresMinutes: 15 });
  try {
    await sendEmail({
      to: user.email,
      subject: "Verificare email / Verify email – LIVADAI",
      html,
      type: "official",
      userId: user._id,
    });
  } catch (err) {
    console.error("Send verification email error", err);
  }
};

const register = async (req, res) => {
  try {
    const { name, email, password, confirmPassword, role, phone, phoneCountryCode, termsAccepted, termsAcceptedAt, termsVersion } = req.body;
    if (!name || !email || !password || !confirmPassword || !phone || !phoneCountryCode) {
      return res.status(400).json({ message: "name, email, password, confirmPassword, phone, phoneCountryCode required" });
    }
    if (password !== confirmPassword) return res.status(400).json({ message: "Passwords do not match" });
    const strengthError = validatePasswordStrength(password);
    if (strengthError) return res.status(400).json({ message: strengthError });
    if (!/^\+?\d{1,4}$/.test(phoneCountryCode)) return res.status(400).json({ message: "Invalid country code" });
    if (!/^\d{6,15}$/.test(String(phone))) return res.status(400).json({ message: "Invalid phone number" });
    if (termsAccepted !== true) return res.status(400).json({ message: "Terms must be accepted" });
    if (!termsVersion) return res.status(400).json({ message: "Terms version required" });
    const acceptedAt = new Date(termsAcceptedAt);
    if (!termsAcceptedAt || Number.isNaN(acceptedAt.getTime())) {
      return res.status(400).json({ message: "Invalid termsAcceptedAt" });
    }

    const existing = await User.findOne({ email });
    console.log("[REGISTER]", {
      email,
      existing: !!existing,
      emailVerified: existing?.emailVerified,
    });
    if (existing) {
      if (!existing.emailVerified) {
        sendEmailVerification(existing).catch((err) => {
          console.error("Send verification email error:", err?.message || err);
        });
        return res.status(200).json({ message: "Verification email resent", requiresEmailVerification: true });
      }
      return res.status(409).json({ message: "Email already registered" });
    }

    const hashed = await bcrypt.hash(password, 10);
    const user = await User.create({
      name,
      email,
      password: hashed,
      role: role === "HOST" ? "HOST" : "EXPLORER",
      isHost: role === "HOST",
      phone,
      phoneCountryCode,
      termsAccepted: true,
      termsAcceptedAt: acceptedAt,
      termsVersion,
      emailVerified: false,
    });

    sendEmailVerification(user).catch((err) => {
      console.error("Send verification email error:", err?.message || err);
    });

    try {
      const appUrl = process.env.FRONTEND_URL || "https://app.livadai.com";
      const html = buildWelcomeEmail({ ctaUrl: appUrl });
      await sendEmail({
        to: user.email,
        subject: "Bine ai venit / Welcome – LIVADAI",
        html,
        type: "welcome_explorer",
        userId: user._id,
      });
    } catch (err) {
      console.error("Welcome email error", err);
    }

    return res.status(201).json({
      message: "User created, verification required",
      requiresEmailVerification: true,
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });
  } catch (err) {
    console.error("Register error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

const login = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ message: "email and password required" });
    }
    const loginKey = getLoginKey(req, email);
    if (isLoginBlocked(loginKey)) {
      return res.status(429).json({ message: "Too many attempts. Please try again later." });
    }

    const user = await User.findOne({ email });
    if (!user) {
      const blocked = recordLoginFailure(loginKey);
      return res.status(blocked ? 429 : 401).json({
        message: blocked ? "Too many attempts. Please try again later." : "Invalid credentials",
      });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      const blocked = recordLoginFailure(loginKey);
      return res.status(blocked ? 429 : 401).json({
        message: blocked ? "Too many attempts. Please try again later." : "Invalid credentials",
      });
    }

    if (!user.emailVerified) {
      return res.status(403).json({ message: "Please verify your email before logging in" });
    }

    user.lastAuthAt = new Date();
    await user.save();
    clearLoginAttempts(loginKey);
    const token = signToken(user);
    return res.json({
      message: "Login successful",
      user: buildAuthUser(user),
      token,
    });
  } catch (err) {
    console.error("Login error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

// Request password reset
const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ message: "Email required" });
    // generic response to avoid user enumeration
    const genericResponse = { message: "If an account exists, you will receive a reset email shortly." };
    const user = await User.findOne({ email });
    if (!user) return res.json(genericResponse);

    const token = crypto.randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + 30 * 60 * 1000); // 30 min
    user.resetPasswordToken = token;
    user.resetPasswordExpires = expires;
    user.resetOtpCode = undefined;
    user.resetOtpExpires = undefined;
    user.resetOtpAttempts = 0;
    await user.save();

    // send email
    const frontendUrl = process.env.FRONTEND_URL || "https://app.livadai.com";
    const normalizedFront = frontendUrl.replace(/\/$/, "");
    const resetLink = `${normalizedFront}/reset-password?token=${token}`;
    const html = buildPasswordResetEmail({ resetUrl: resetLink });
    try {
      await sendEmail({
        to: user.email,
        subject: "Resetare parolă / Password reset – LIVADAI",
        html,
        type: "official",
        userId: user._id,
      });
    } catch (err) {
      console.error("Forgot password email error", err);
      // still return generic response
    }

    return res.json(genericResponse);
  } catch (err) {
    console.error("Forgot password error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

// Reset password with token
const resetPassword = async (req, res) => {
  try {
    const { token, password, confirmPassword } = req.body || {};
    if (!token || !password || !confirmPassword) return res.status(400).json({ message: "token, password, confirmPassword required" });
    if (password !== confirmPassword) return res.status(400).json({ message: "Passwords do not match" });
    const strengthError = validatePasswordStrength(password);
    if (strengthError) return res.status(400).json({ message: strengthError });

    const user = await User.findOne({
      resetPasswordToken: token,
      resetPasswordExpires: { $gt: new Date() },
    });
    if (!user) return res.status(400).json({ message: "Invalid or expired token" });

    const hashed = await bcrypt.hash(password, 10);
    user.password = hashed;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();
    try {
      const html = buildPasswordChangedEmail({});
      await sendEmail({
        to: user.email,
        subject: "Parolă schimbată / Password changed – LIVADAI",
        html,
        type: "official",
        userId: user._id,
      });
    } catch (err) {
      console.error("Password changed email error", err);
    }

    return res.json({ message: "Password reset successful" });
  } catch (err) {
    console.error("Reset password error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

// ---------------- OTP RESET (MOBILE FIRST) ----------------
const FORGOT_GENERIC = { message: "If an account exists, you will receive a reset email shortly." };
const OTP_MAX_ATTEMPTS = 5;
const OTP_EXPIRE_MIN = 15;

const forgotPasswordOtp = async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ message: "Email required" });
    const user = await User.findOne({ email });
    if (!user) return res.json(FORGOT_GENERIC);

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    user.resetOtpCode = otp;
    user.resetOtpExpires = new Date(Date.now() + OTP_EXPIRE_MIN * 60 * 1000);
    user.resetOtpAttempts = 0;
    // invalidate old token flow to avoid paralel flows
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();

    const html = buildPasswordResetEmail({ code: otp });
    try {
      await sendEmail({
        to: user.email,
        subject: "Cod resetare / Reset code – LIVADAI",
        html,
        type: "official",
        userId: user._id,
      });
    } catch (err) {
      console.error("Forgot OTP email error", err);
    }

    return res.json(FORGOT_GENERIC);
  } catch (err) {
    console.error("Forgot password OTP error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

const resetPasswordOtp = async (req, res) => {
  try {
    const { email, otpCode, password, confirmPassword } = req.body || {};
    if (!email || !otpCode || !password || !confirmPassword) {
      return res.status(400).json({ message: "email, otpCode, password, confirmPassword required" });
    }
    if (password !== confirmPassword) return res.status(400).json({ message: "Passwords do not match" });
    const strengthError = validatePasswordStrength(password);
    if (strengthError) return res.status(400).json({ message: strengthError });

    const user = await User.findOne({ email });
    if (!user || !user.resetOtpCode || !user.resetOtpExpires) {
      return res.status(400).json({ message: "Invalid or expired code" });
    }
    if (user.resetOtpAttempts >= OTP_MAX_ATTEMPTS) {
      return res.status(400).json({ message: "Too many attempts" });
    }
    if (new Date(user.resetOtpExpires) < new Date()) {
      return res.status(400).json({ message: "Invalid or expired code" });
    }
    if (user.resetOtpCode !== otpCode) {
      user.resetOtpAttempts = (user.resetOtpAttempts || 0) + 1;
      await user.save();
      return res.status(400).json({ message: "Invalid or expired code" });
    }

    const hashed = await bcrypt.hash(password, 10);
    user.password = hashed;
    user.resetOtpCode = undefined;
    user.resetOtpExpires = undefined;
    user.resetOtpAttempts = 0;
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();
    try {
      const html = buildPasswordChangedEmail({});
      await sendEmail({
        to: user.email,
        subject: "Parolă schimbată / Password changed – LIVADAI",
        html,
        type: "official",
        userId: user._id,
      });
    } catch (err) {
      console.error("Password changed email error", err);
    }

    return res.json({ message: "Password reset successful" });
  } catch (err) {
    console.error("Reset password OTP error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

// Verify email with OTP
const verifyEmail = async (req, res) => {
  try {
    const { email, code } = req.body || {};
    if (!email || !code) return res.status(400).json({ message: "email and code required" });
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ message: "Invalid or expired code" });
    if (user.emailVerified) return res.json({ message: "Email already verified", token: signToken(user) });
    if (!user.emailVerificationCode || !user.emailVerificationExpires) return res.status(400).json({ message: "Invalid or expired code" });
    if (user.emailVerificationAttempts >= 5) return res.status(400).json({ message: "Too many attempts" });
    if (new Date(user.emailVerificationExpires) < new Date()) return res.status(400).json({ message: "Invalid or expired code" });
    if (user.emailVerificationCode !== code) {
      user.emailVerificationAttempts = (user.emailVerificationAttempts || 0) + 1;
      await user.save();
      return res.status(400).json({ message: "Invalid or expired code" });
    }

    user.emailVerified = true;
    user.emailVerificationCode = undefined;
    user.emailVerificationExpires = undefined;
    user.emailVerificationAttempts = 0;
    await user.save();

    const token = signToken(user);
    return res.json({ message: "Email verified", token, user: { _id: user._id, name: user.name, email: user.email, role: user.role } });
  } catch (err) {
    console.error("Verify email error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

const buildAuthUser = (user) => ({
  _id: user._id,
  email: user.email,
  role: user.role,
  avatar: user.avatar || user.profilePhoto || "",
});

const getMe = async (req, res) => {
  try {
    const user = await User.findById(req.user?.id);
    if (!user) return res.status(404).json({ message: "User not found" });
    return res.json({ user: buildAuthUser(user) });
  } catch (err) {
    console.error("Get me error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

const reauth = async (req, res) => {
  try {
    const { password } = req.body || {};
    if (!password) return res.status(400).json({ message: "password required" });
    const user = await User.findById(req.user?.id).select("password");
    if (!user) return res.status(404).json({ message: "User not found" });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ message: "Invalid credentials" });
    user.lastAuthAt = new Date();
    await user.save();
    return res.json({ message: "Re-authenticated" });
  } catch (err) {
    console.error("Reauth error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

const resendEmailVerification = async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ message: "Email required" });
    const user = await User.findOne({ email });
    if (!user) return res.json({ message: "If an account exists, you will receive a code." });
    if (user.emailVerified) return res.json({ message: "Email already verified" });

    await sendEmailVerification(user);
    return res.json({ message: "Verification code sent" });
  } catch (err) {
    console.error("Resend verification error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

// Become host: EXPLORER -> BOTH, complete host profile
const becomeHost = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const { displayName, bio, languages, city, country, phone, phoneCountryCode, acceptTerms, confirmInfo } = req.body || {};
    if (!acceptTerms || !confirmInfo) return res.status(400).json({ message: "Please accept terms and confirm info" });
    if (!displayName || !bio || !city || !country) return res.status(400).json({ message: "Missing host profile fields" });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });
    if (user.isBanned || user.isBlocked) return res.status(403).json({ message: "User banned/blocked" });

    // Update host profile
    user.hostProfile = {
      displayName,
      bio,
      languages: Array.isArray(languages) ? languages : [],
      city,
      country,
      phone: phone || user.phone,
      avatar: user.avatar || user.profilePhoto,
    };
    user.isHost = true;
    user.role = user.role === "ADMIN" ? "ADMIN" : user.role === "HOST" ? "HOST" : "BOTH";
    await user.save();

    const token = signToken(user);
    return res.json({
      message: "Host activated",
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        isHost: user.isHost,
      },
      token,
    });
  } catch (err) {
    console.error("Become host error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

module.exports = {
  register,
  login,
  forgotPassword,
  resetPassword,
  forgotPasswordOtp,
  resetPasswordOtp,
  verifyEmail,
  resendEmailVerification,
  reauth,
  becomeHost,
  getMe,
};
