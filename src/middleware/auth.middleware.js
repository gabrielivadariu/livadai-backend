const jwt = require("jsonwebtoken");
const User = require("../models/user.model");

const authenticate = async (req, res, next) => {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.split(" ")[1]
    : null;

  if (!token) {
    return res.status(401).json({ message: "Authorization token missing" });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(payload.userId).select("role tokenVersion lastAuthAt email isBlocked isBanned");
    if (!user) return res.status(401).json({ message: "Invalid or expired token" });
    if ((user.tokenVersion || 0) !== (payload.tokenVersion || 0)) {
      return res.status(401).json({ message: "Invalid or expired token" });
    }
    if (user.isBlocked || user.isBanned) {
      return res.status(403).json({ message: "User blocked" });
    }
    req.user = { id: user._id.toString(), role: user.role, lastAuthAt: user.lastAuthAt, email: user.email };
    return next();
  } catch (err) {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
};

const optionalAuthenticate = async (req, _res, next) => {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.split(" ")[1] : null;

  if (!token) return next();

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(payload.userId).select("role tokenVersion lastAuthAt email isBlocked isBanned");
    if (!user) return next();
    if ((user.tokenVersion || 0) !== (payload.tokenVersion || 0)) return next();
    if (user.isBlocked || user.isBanned) return next();
    req.user = { id: user._id.toString(), role: user.role, lastAuthAt: user.lastAuthAt, email: user.email };
  } catch (_err) {
    // ignore invalid token
  }
  return next();
};

const requireRecentAuth = (req, res, next) => {
  const lastAuthAt = req.user?.lastAuthAt ? new Date(req.user.lastAuthAt).getTime() : 0;
  const now = Date.now();
  if (!lastAuthAt || now - lastAuthAt > 15 * 60 * 1000) {
    return res.status(401).json({ message: "Re-authentication required" });
  }
  return next();
};

const authorize = (roles = []) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return res.status(403).json({ message: "Forbidden" });
  }
  return next();
};

module.exports = { authenticate, optionalAuthenticate, authorize, requireRecentAuth };
