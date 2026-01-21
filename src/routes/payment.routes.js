const { Router } = require("express");
const { createCheckout } = require("../controllers/payment.controller");
const { authenticate, authorize } = require("../middleware/auth.middleware");

const router = Router();

router.post("/create-checkout", authenticate, authorize(["EXPLORER", "HOST", "BOTH"]), createCheckout);

module.exports = router;
