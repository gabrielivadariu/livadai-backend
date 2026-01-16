const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../models/user.model");
const crypto = require("crypto");
const { sendMail } = require("../utils/mailer");

const signToken = (user) => {
  return jwt.sign(
    {
      userId: user._id,
      role: user.role,
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
  const html = `
    <div style="background:#f3f4f6;padding:24px 12px;font-family:Arial,sans-serif;">
      <table align="center" style="max-width:520px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;">
        <tr>
          <td style="background:#06b6d4;color:#ffffff;text-align:center;padding:18px 12px;">
            <div style="font-size:22px;font-weight:800;letter-spacing:1px;">LIVADAI</div>
            <div style="font-size:13px;opacity:0.85;margin-top:4px;">Explorers & Hosts</div>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 24px;color:#0f172a;">
            <h2 style="margin:0 0 8px 0;font-size:20px;font-weight:800;color:#0f172a;">Verifică adresa de email</h2>
            <p style="margin:0 0 12px 0;font-size:15px;line-height:1.6;color:#334155;">
              Folosește codul de mai jos pentru a confirma adresa de email și a activa contul tău LIVADAI.
            </p>
            <div style="margin:16px 0;padding:14px 16px;background:#ecfeff;border:1px solid #bae6fd;border-radius:10px;text-align:center;">
              <div style="font-size:32px;font-weight:800;letter-spacing:6px;color:#0f172a;">${otp}</div>
              <div style="font-size:13px;color:#475569;margin-top:6px;">Codul expiră în 15 minute.</div>
            </div>
            <p style="margin:0 0 10px 0;font-size:14px;line-height:1.6;color:#475569;">
              Dacă nu ai creat tu contul, poți ignora acest email.
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding:14px;text-align:center;font-size:12px;color:#94a3b8;background:#f8fafc;">
            © LIVADAI
          </td>
        </tr>
      </table>
    </div>
  `;
  try {
    await sendMail({ to: user.email, subject: "Verificare email – LIVADAI", html });
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
    if (!/^\+?\d{1,4}$/.test(phoneCountryCode)) return res.status(400).json({ message: "Invalid country code" });
    if (!/^\d{6,15}$/.test(String(phone))) return res.status(400).json({ message: "Invalid phone number" });
    if (termsAccepted !== true) return res.status(400).json({ message: "Terms must be accepted" });
    if (!termsVersion) return res.status(400).json({ message: "Terms version required" });
    const acceptedAt = new Date(termsAcceptedAt);
    if (!termsAcceptedAt || Number.isNaN(acceptedAt.getTime())) {
      return res.status(400).json({ message: "Invalid termsAcceptedAt" });
    }

    const existing = await User.findOne({ email });
    if (existing) {
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

    await sendEmailVerification(user);

    return res.status(201).json({
      message: "User created, verification required",
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

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    if (!user.emailVerified) {
      return res.status(403).json({ message: "Email not verified" });
    }

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
    await user.save();

    // send email
    const frontendUrl = process.env.FRONTEND_URL || "https://app.livadai.com";
    const normalizedFront = frontendUrl.replace(/\/$/, "");
    const resetLink = `${normalizedFront}/reset-password?token=${token}`;
    const html = `
      <h3>Resetare parolă</h3>
      <p>Ai solicitat resetarea parolei pentru contul tău LIVADAI.</p>
      <p>Apasă pe butonul de mai jos pentru a seta o parolă nouă. Link-ul expiră în 30 de minute.</p>
      <p><a href="${resetLink}" style="display:inline-block;padding:10px 16px;background:#06b6d4;color:#fff;border-radius:8px;text-decoration:none;font-weight:700;">Resetează parola</a></p>
      <p>Dacă nu ai solicitat tu această resetare, poți ignora acest email.</p>
    `;
    try {
      await sendMail({
        to: user.email,
        subject: "Resetare parolă – LIVADAI",
        html,
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
    if (password.length < 8) return res.status(400).json({ message: "Password too short" });

    const user = await User.findOne({
      resetPasswordToken: token,
      resetPasswordExpires: { $gt: new Date() },
    });
    if (!user) return res.status(400).json({ message: "Invalid or expired token" });

    const hashed = await bcrypt.hash(password, 10);
    user.password = hashed;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();

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

    const html = `
      <div style="background:#f3f4f6;padding:24px 12px;font-family:Arial,sans-serif;">
        <table align="center" style="max-width:520px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;">
          <tr>
            <td style="background:#06b6d4;color:#ffffff;text-align:center;padding:18px 12px;">
              <div style="font-size:22px;font-weight:800;letter-spacing:1px;">LIVADAI</div>
              <div style="font-size:13px;opacity:0.85;margin-top:4px;">Explorers & Hosts</div>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 24px;color:#0f172a;">
              <h2 style="margin:0 0 8px 0;font-size:20px;font-weight:800;color:#0f172a;">Cod resetare parolă</h2>
              <p style="margin:0 0 12px 0;font-size:15px;line-height:1.6;color:#334155;">
                Ai solicitat resetarea parolei pentru contul tău LIVADAI. Folosește codul de mai jos pentru a continua.
              </p>
              <div style="margin:16px 0;padding:14px 16px;background:#ecfeff;border:1px solid #bae6fd;border-radius:10px;text-align:center;">
                <div style="font-size:32px;font-weight:800;letter-spacing:6px;color:#0f172a;">${otp}</div>
                <div style="font-size:13px;color:#475569;margin-top:6px;">Codul expiră în ${OTP_EXPIRE_MIN} minute.</div>
              </div>
              <p style="margin:0 0 10px 0;font-size:14px;line-height:1.6;color:#475569;">
                Dacă nu ai solicitat tu această resetare, poți ignora acest email.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:14px;text-align:center;font-size:12px;color:#94a3b8;background:#f8fafc;">
              © LIVADAI
            </td>
          </tr>
        </table>
      </div>
    `;
    try {
      await sendMail({
        to: user.email,
        subject: "Cod resetare parolă – LIVADAI",
        html,
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
    if (password.length < 8) return res.status(400).json({ message: "Password too short" });

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
    await user.save();

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
  name: user.name,
  email: user.email,
  role: user.role,
  isHost: user.isHost,
  stripeAccountId: user.stripeAccountId,
  isStripeChargesEnabled: user.isStripeChargesEnabled,
  isStripePayoutsEnabled: user.isStripePayoutsEnabled,
  isStripeDetailsSubmitted: user.isStripeDetailsSubmitted,
  rating_avg: user.rating_avg,
  rating_count: user.rating_count,
  displayName: user.displayName,
  display_name: user.display_name,
  avatar: user.avatar,
  profilePhoto: user.profilePhoto,
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
  becomeHost,
  getMe,
};
