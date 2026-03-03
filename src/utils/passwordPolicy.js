const passwordPolicyRegex = /^.{8,}$/;
const passwordPolicyMessage = "Password must be at least 8 characters long.";

const validatePasswordStrength = (password) => {
  if (!passwordPolicyRegex.test(password || "")) return passwordPolicyMessage;
  return null;
};

module.exports = {
  passwordPolicyRegex,
  passwordPolicyMessage,
  validatePasswordStrength,
};
