const { Router } = require("express");
const { authenticate, requireRecentAuth } = require("../middleware/auth.middleware");
const {
  getMeProfile,
  updateMeProfile,
  getPublicProfile,
  deleteMe,
  requestDeleteOtp,
  confirmDeleteOtp,
  changePassword,
  changeEmail,
  getMyFavorites,
  toggleFavorite,
} = require("../controllers/user.controller");

const router = Router();

// Current user profile (view/edit)
router.get("/me", authenticate, getMeProfile);
router.put("/me", authenticate, updateMeProfile);
router.delete("/me", authenticate, deleteMe);
router.post("/me/delete-request", authenticate, requireRecentAuth, requestDeleteOtp);
router.post("/me/delete-confirm", authenticate, requireRecentAuth, confirmDeleteOtp);
router.post("/me/password", authenticate, requireRecentAuth, changePassword);
router.post("/me/email", authenticate, requireRecentAuth, changeEmail);
router.get("/me/favorites", authenticate, getMyFavorites);
router.post("/me/favorites/:id", authenticate, toggleFavorite);

// Public profile for host (requires auth)
router.get("/:id/public-profile", authenticate, getPublicProfile);

// Backward compatibility
router.get("/me/profile", authenticate, getMeProfile);
router.put("/me/profile", authenticate, updateMeProfile);
router.delete("/me/profile", authenticate, deleteMe);

module.exports = router;
