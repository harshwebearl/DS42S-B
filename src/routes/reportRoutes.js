const express = require('express');
const router = express.Router();
const reportController = require('../controllers/reportController');
const { authDirector } = require('../middleware/auth');

router.use(authDirector);

router.get('/:type', reportController.getReport);
router.get('/:type/export-excel', reportController.exportReportExcel);

module.exports = router;
