const express = require("express");
const router = express.Router();
const { createGroup, joinGroup } = require("../controllers/groupController");

router.post("/create", createGroup);
router.post("/join", joinGroup);

module.exports = router;