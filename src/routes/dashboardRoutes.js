const express = require('express');
const router = express.Router();
const dashboardController = require('../controllers/dashboardController');
const { authDirector } = require('../middleware/auth');

router.use(authDirector);

router.get('/stats', dashboardController.getDashboardStats);

module.exports = router;
