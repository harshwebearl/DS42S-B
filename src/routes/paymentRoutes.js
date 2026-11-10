const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/paymentController');
const { authDirector } = require('../middleware/auth');

router.use(authDirector);

router.post('/single', paymentController.createSinglePayment);
router.post('/bulk', paymentController.createBulkPayment);
router.put('/:id', paymentController.editPayment);
router.get('/', paymentController.getPayments);
router.get('/:id', paymentController.getPaymentById);

module.exports = router;
