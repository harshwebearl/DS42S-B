const express = require('express');
const router = express.Router();
const reallocationController = require('../controllers/reallocationController');
const { authDirector } = require('../middleware/auth');

router.use(authDirector);

router.post('/:id', reallocationController.reallocateBulkPayment);

module.exports = router;
