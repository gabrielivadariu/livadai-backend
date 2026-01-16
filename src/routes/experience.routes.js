const { Router } = require("express");
const {
  createExperience,
  getMyExperiences,
  updateExperience,
  deleteExperience,
  listExperiences,
  getExperienceById,
  getExperiencesMap,
  cancelExperience,
} = require("../controllers/experience.controller");
const { authenticate, authorize } = require("../middleware/auth.middleware");

const router = Router();

// Host actions
router.post("/", authenticate, authorize(["HOST"]), createExperience);
router.get("/me", authenticate, authorize(["HOST"]), getMyExperiences);
router.patch("/:id", authenticate, authorize(["HOST"]), updateExperience);
router.delete("/:id", authenticate, authorize(["HOST"]), deleteExperience);
router.post("/:id/cancel", authenticate, authorize(["HOST"]), cancelExperience);

// Explorer/public
router.get("/map", getExperiencesMap);
router.get("/:id", getExperienceById);
router.get("/", listExperiences);

module.exports = router;
