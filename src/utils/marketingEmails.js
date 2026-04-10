const crypto = require("crypto");

const generateUnsubscribeToken = () => crypto.randomBytes(32).toString("hex");

module.exports = {
  generateUnsubscribeToken,
};
