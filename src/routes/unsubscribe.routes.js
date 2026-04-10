const { Router } = require("express");
const { unsubscribeFromMarketingEmails } = require("../controllers/user.controller");

const router = Router();

router.get("/", unsubscribeFromMarketingEmails);

module.exports = router;
