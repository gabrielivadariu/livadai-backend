const AUTH_COOKIE_NAME = process.env.AUTH_COOKIE_NAME || "livadai_token";
const AUTH_COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const parseCookies = (cookieHeader = "") => {
  return cookieHeader
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .reduce((acc, item) => {
      const eqIndex = item.indexOf("=");
      if (eqIndex <= 0) return acc;
      const key = item.slice(0, eqIndex).trim();
      const value = item.slice(eqIndex + 1).trim();
      acc[key] = decodeURIComponent(value);
      return acc;
    }, {});
};

const getAuthTokenFromCookie = (req) => {
  const cookies = parseCookies(req?.headers?.cookie || "");
  return cookies[AUTH_COOKIE_NAME] || null;
};

const buildCookieOptions = () => {
  const options = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: AUTH_COOKIE_MAX_AGE_MS,
  };
  if (process.env.AUTH_COOKIE_DOMAIN) {
    options.domain = process.env.AUTH_COOKIE_DOMAIN;
  }
  return options;
};

const setAuthCookie = (res, token) => {
  res.cookie(AUTH_COOKIE_NAME, token, buildCookieOptions());
};

const clearAuthCookie = (res) => {
  const options = buildCookieOptions();
  res.clearCookie(AUTH_COOKIE_NAME, {
    httpOnly: options.httpOnly,
    secure: options.secure,
    sameSite: options.sameSite,
    path: options.path,
    ...(options.domain ? { domain: options.domain } : {}),
  });
};

module.exports = {
  AUTH_COOKIE_NAME,
  getAuthTokenFromCookie,
  setAuthCookie,
  clearAuthCookie,
};
