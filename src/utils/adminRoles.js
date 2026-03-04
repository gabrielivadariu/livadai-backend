const ADMIN_CAPABILITIES = {
  PANEL_READ: "PANEL_READ",
  USERS_WRITE: "USERS_WRITE",
  EXPERIENCES_WRITE: "EXPERIENCES_WRITE",
  BOOKINGS_WRITE: "BOOKINGS_WRITE",
  REPORTS_WRITE: "REPORTS_WRITE",
  OWNER_WRITE: "OWNER_WRITE",
};

const ADMIN_ROLES = [
  "OWNER_ADMIN",
  "ADMIN", // legacy full-access role
  "ADMIN_SUPPORT",
  "ADMIN_RISK",
  "ADMIN_FINANCE",
  "ADMIN_VIEWER",
];

const BASE_USER_ROLES = ["EXPLORER", "HOST", "BOTH"];
const ALL_USER_ROLES = [...BASE_USER_ROLES, ...ADMIN_ROLES];

const ROLE_CAPABILITIES = {
  OWNER_ADMIN: ["*"],
  ADMIN: [
    ADMIN_CAPABILITIES.PANEL_READ,
    ADMIN_CAPABILITIES.USERS_WRITE,
    ADMIN_CAPABILITIES.EXPERIENCES_WRITE,
    ADMIN_CAPABILITIES.BOOKINGS_WRITE,
    ADMIN_CAPABILITIES.REPORTS_WRITE,
  ],
  ADMIN_SUPPORT: [
    ADMIN_CAPABILITIES.PANEL_READ,
    ADMIN_CAPABILITIES.BOOKINGS_WRITE,
    ADMIN_CAPABILITIES.REPORTS_WRITE,
  ],
  ADMIN_RISK: [
    ADMIN_CAPABILITIES.PANEL_READ,
    ADMIN_CAPABILITIES.USERS_WRITE,
    ADMIN_CAPABILITIES.EXPERIENCES_WRITE,
    ADMIN_CAPABILITIES.REPORTS_WRITE,
  ],
  ADMIN_FINANCE: [
    ADMIN_CAPABILITIES.PANEL_READ,
    ADMIN_CAPABILITIES.BOOKINGS_WRITE,
  ],
  ADMIN_VIEWER: [ADMIN_CAPABILITIES.PANEL_READ],
};

const normalizeRole = (role = "") => String(role || "").trim().toUpperCase();

const isAdminRole = (role = "") => ADMIN_ROLES.includes(normalizeRole(role));

const getAdminCapabilities = (role = "") => {
  const normalizedRole = normalizeRole(role);
  const capabilities = ROLE_CAPABILITIES[normalizedRole] || [];
  if (!capabilities.length) return [];
  if (capabilities.includes("*")) return [...new Set(Object.values(ADMIN_CAPABILITIES))];
  return [...new Set(capabilities)];
};

const hasAdminCapability = (role = "", capability = "") => {
  const normalizedRole = normalizeRole(role);
  const normalizedCapability = String(capability || "").trim();
  if (!normalizedCapability) return false;
  const capabilities = getAdminCapabilities(normalizedRole);
  if (!capabilities.length) return false;
  return capabilities.includes(normalizedCapability);
};

module.exports = {
  ADMIN_CAPABILITIES,
  ADMIN_ROLES,
  BASE_USER_ROLES,
  ALL_USER_ROLES,
  ROLE_CAPABILITIES,
  normalizeRole,
  isAdminRole,
  getAdminCapabilities,
  hasAdminCapability,
};
