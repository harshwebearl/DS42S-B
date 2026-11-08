const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { authDirector } = require('../middleware/auth');

router.post('/login', authController.login);
router.post('/forgot-password', authController.forgotPassword);
router.post('/reset-password', authController.resetPassword);

router.get('/profile', authDirector, authController.getProfile);
router.put('/profile', authDirector, authController.updateProfile);
router.post('/change-password', authDirector, authController.changePassword);

module.exports = router;
