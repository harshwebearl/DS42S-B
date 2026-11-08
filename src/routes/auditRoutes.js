const express = require('express');
const router = express.Router();
const auditController = require('../controllers/auditController');
const { authDirector } = require('../middleware/auth');

router.use(authDirector);

router.get('/', auditController.getAuditLogs);

module.exports = router;
