const passwordPolicyRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/;
const passwordPolicyMessage =
  "Password must be at least 8 characters and include uppercase, lowercase, number, and special character.";

const validatePasswordStrength = (password) => {
  if (!passwordPolicyRegex.test(password || "")) return passwordPolicyMessage;
  return null;
};

module.exports = {
  passwordPolicyRegex,
  passwordPolicyMessage,
  validatePasswordStrength,
};
