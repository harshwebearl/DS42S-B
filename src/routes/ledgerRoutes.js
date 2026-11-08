const express = require('express');
const router = express.Router();
const ledgerController = require('../controllers/ledgerController');
const { authDirector } = require('../middleware/auth');

router.use(authDirector);

router.get('/member/:memberId', ledgerController.getMemberLedger);

module.exports = router;
