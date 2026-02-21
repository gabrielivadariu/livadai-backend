const { Router } = require("express");
const { authenticate, authorize, optionalAuthenticate } = require("../middleware/auth.middleware");
const {
  getHostProfile,
  getMyHostProfile,
  getHostReviews,
  getHostActivities,
  updateMyProfile,
  addHostReview,
} = require("../controllers/host.controller");

const router = Router();

router.get("/me/profile", authenticate, authorize(["HOST"]), getMyHostProfile);
router.get("/:id/profile", optionalAuthenticate, getHostProfile);
router.get("/:id/reviews", getHostReviews);
router.get("/:id/activities", getHostActivities);
router.put("/me/profile", authenticate, authorize(["HOST"]), updateMyProfile);
router.post("/:id/reviews", authenticate, addHostReview);

module.exports = router;
