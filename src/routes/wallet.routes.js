const { Router } = require("express");
const { authenticate, authorize } = require("../middleware/auth.middleware");
const { aggregateHostBalances } = require("../utils/wallet");

const router = Router();

router.get("/summary", authenticate, authorize(["HOST"]), async (req, res) => {
  try {
    const balances = await aggregateHostBalances(req.user.id);
    return res.json(balances);
  } catch (err) {
    console.error("Wallet summary error", err);
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
