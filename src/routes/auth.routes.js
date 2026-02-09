const { Router } = require("express");
const {
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
  logout,
} = require("../controllers/auth.controller");
const { authenticate } = require("../middleware/auth.middleware");

const router = Router();

router.post("/register", register);
router.post("/login", login);
router.post("/forgot-password", forgotPassword);
router.post("/reset-password", resetPassword);
router.post("/forgot-password-otp", forgotPasswordOtp);
router.post("/reset-password-otp", resetPasswordOtp);
router.post("/verify-email", verifyEmail);
router.post("/verify-email-code", verifyEmail);
router.post("/resend-email-verification", resendEmailVerification);
router.post("/reauth", authenticate, reauth);
router.post("/become-host", authenticate, becomeHost);
router.get("/me", authenticate, getMe);
router.post("/logout", logout);

module.exports = router;
