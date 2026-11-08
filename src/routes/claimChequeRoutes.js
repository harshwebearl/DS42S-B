const express = require('express');
const router = express.Router();
const claimChequeController = require('../controllers/claimChequeController');
const { authDirector } = require('../middleware/auth');
const upload = require('../middleware/upload');

router.use(authDirector);

router.post('/', claimChequeController.issueClaimCheque);
router.get('/', claimChequeController.getClaimCheques);
router.post('/:id/handover', upload.single('handoverAckDocument'), claimChequeController.recordHandover);
router.patch('/:id/status', claimChequeController.updateClaimChequeStatus);

module.exports = router;
