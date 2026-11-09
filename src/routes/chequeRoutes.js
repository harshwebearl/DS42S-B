const express = require('express');
const router = express.Router();
const chequeController = require('../controllers/chequeController');
const { authDirector } = require('../middleware/auth');

router.use(authDirector);

router.get('/', chequeController.getCheques);
router.patch('/:id/status', chequeController.updateChequeStatus);
router.delete('/:id', chequeController.deleteCheque);

module.exports = router;
