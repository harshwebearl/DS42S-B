const express = require('express');
const router = express.Router();
const financialYearController = require('../controllers/financialYearController');
const { authDirector } = require('../middleware/auth');

router.use(authDirector);

router.post('/', financialYearController.createFinancialYear);
router.get('/', financialYearController.getFinancialYears);
router.put('/:id', financialYearController.updateFinancialYear);

module.exports = router;
