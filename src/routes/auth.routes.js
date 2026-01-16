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
  becomeHost,
  getMe,
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
router.post("/resend-email-verification", resendEmailVerification);
router.post("/become-host", authenticate, becomeHost);
router.get("/me", authenticate, getMe);

module.exports = router;
