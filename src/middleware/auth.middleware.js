const jwt = require("jsonwebtoken");
const User = require("../models/user.model");
const { getAuthTokenFromCookie, setAuthCookie } = require("../utils/authCookies");

const getBearerToken = (req) => {
  const authHeader = req.headers.authorization || "";
  return authHeader.startsWith("Bearer ") ? authHeader.split(" ")[1] : null;
};

const getAuthCandidates = (req) => {
  const cookieToken = getAuthTokenFromCookie(req);
  const bearerToken = getBearerToken(req);
  const candidates = [];
  if (cookieToken) candidates.push({ token: cookieToken, source: "cookie" });
  if (bearerToken && bearerToken !== cookieToken) candidates.push({ token: bearerToken, source: "bearer" });
  return { candidates, cookieToken };
};

const resolveUserFromToken = async (token) => {
  const payload = jwt.verify(token, process.env.JWT_SECRET);
  const user = await User.findById(payload.userId).select("role tokenVersion lastAuthAt email isBlocked isBanned");
  if (!user) return null;
  if ((user.tokenVersion || 0) !== (payload.tokenVersion || 0)) return null;
  if (user.isBlocked || user.isBanned) return { blocked: true };
  return {
    id: user._id.toString(),
    role: user.role,
    lastAuthAt: user.lastAuthAt,
    email: user.email,
  };
};

const authenticate = async (req, res, next) => {
  const { candidates, cookieToken } = getAuthCandidates(req);

  if (!candidates.length) {
    return res.status(401).json({ message: "Authorization token missing" });
  }

  for (const candidate of candidates) {
    try {
      const resolved = await resolveUserFromToken(candidate.token);
      if (!resolved) continue;
      if (resolved.blocked) {
        return res.status(403).json({ message: "User blocked" });
      }
      req.user = resolved;
      // Seamless migration path: bearer token users receive HttpOnly cookie.
      if (candidate.source === "bearer" && !cookieToken) {
        setAuthCookie(res, candidate.token);
      }
      return next();
    } catch (_err) {
      // keep trying next candidate token
    }
  }
  return res.status(401).json({ message: "Invalid or expired token" });
};

const optionalAuthenticate = async (req, res, next) => {
  const { candidates, cookieToken } = getAuthCandidates(req);
  if (!candidates.length) return next();

  for (const candidate of candidates) {
    try {
      const resolved = await resolveUserFromToken(candidate.token);
      if (!resolved || resolved.blocked) continue;
      req.user = resolved;
      if (candidate.source === "bearer" && !cookieToken) {
        setAuthCookie(res, candidate.token);
      }
      break;
    } catch (_err) {
      // ignore invalid candidate
    }
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
