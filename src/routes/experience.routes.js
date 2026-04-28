const { Router } = require("express");
const {
  createExperience,
  createRecurringExperiences,
  getMyExperiences,
  getHostSeriesSlots,
  updateExperience,
  deleteExperience,
  deleteExperienceGroup,
  processHostSeriesSlot,
  processHostSeriesDay,
  listExperiences,
  getExperienceById,
  getExperienceAvailability,
  getExperiencesMap,
  cancelExperience,
} = require("../controllers/experience.controller");
const { authenticate, optionalAuthenticate, authorize } = require("../middleware/auth.middleware");

const router = Router();

// Host actions
router.post("/", authenticate, authorize(["HOST"]), createExperience);
router.post("/bulk", authenticate, authorize(["HOST"]), createRecurringExperiences);
router.get("/me", authenticate, authorize(["HOST"]), getMyExperiences);
router.get("/group/:groupId/slots", authenticate, authorize(["HOST"]), getHostSeriesSlots);
router.post("/group/:groupId/slots/:slotId/process", authenticate, authorize(["HOST"]), processHostSeriesSlot);
router.post("/group/:groupId/days/:dateKey/process", authenticate, authorize(["HOST"]), processHostSeriesDay);
router.delete("/group/:groupId", authenticate, authorize(["HOST"]), deleteExperienceGroup);
router.patch("/:id", authenticate, authorize(["HOST"]), updateExperience);
router.delete("/:id", authenticate, authorize(["HOST"]), deleteExperience);
router.post("/:id/cancel", authenticate, authorize(["HOST"]), cancelExperience);

// Explorer/public
router.get("/map", getExperiencesMap);
router.get("/:id/availability", optionalAuthenticate, getExperienceAvailability);
router.get("/:id", optionalAuthenticate, getExperienceById);
router.get("/", listExperiences);

module.exports = router;
