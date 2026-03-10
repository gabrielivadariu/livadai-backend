const { Router } = require("express");
const {
  createExperience,
  createRecurringExperiences,
  getMyExperiences,
  updateExperience,
  deleteExperience,
  listExperiences,
  getExperienceById,
  getExperiencesMap,
  cancelExperience,
} = require("../controllers/experience.controller");
const { authenticate, optionalAuthenticate, authorize } = require("../middleware/auth.middleware");

const router = Router();

// Host actions
router.post("/", authenticate, authorize(["HOST"]), createExperience);
router.post("/bulk", authenticate, authorize(["HOST"]), createRecurringExperiences);
router.get("/me", authenticate, authorize(["HOST"]), getMyExperiences);
router.patch("/:id", authenticate, authorize(["HOST"]), updateExperience);
router.delete("/:id", authenticate, authorize(["HOST"]), deleteExperience);
router.post("/:id/cancel", authenticate, authorize(["HOST"]), cancelExperience);

// Explorer/public
router.get("/map", getExperiencesMap);
router.get("/:id", optionalAuthenticate, getExperienceById);
router.get("/", listExperiences);

module.exports = router;
