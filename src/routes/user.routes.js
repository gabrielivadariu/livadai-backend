const { Router } = require("express");
const { authenticate } = require("../middleware/auth.middleware");
const { getMeProfile, updateMeProfile, getPublicProfile, deleteMe, getMyFavorites, toggleFavorite } = require("../controllers/user.controller");

const router = Router();

// Current user profile (view/edit)
router.get("/me", authenticate, getMeProfile);
router.put("/me", authenticate, updateMeProfile);
router.delete("/me", authenticate, deleteMe);
router.get("/me/favorites", authenticate, getMyFavorites);
router.post("/me/favorites/:id", authenticate, toggleFavorite);

// Public profile for host (requires auth)
router.get("/:id/public-profile", authenticate, getPublicProfile);

// Backward compatibility
router.get("/me/profile", authenticate, getMeProfile);
router.put("/me/profile", authenticate, updateMeProfile);
router.delete("/me/profile", authenticate, deleteMe);

module.exports = router;
