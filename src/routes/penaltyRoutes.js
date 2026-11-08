const express = require('express');
const router = express.Router();
const penaltyController = require('../controllers/penaltyController');
const { authDirector } = require('../middleware/auth');

router.use(authDirector);

router.post('/masters', penaltyController.createPenaltyMaster);
router.get('/masters', penaltyController.getPenaltyMasters);
router.post('/assign', penaltyController.assignPenaltyToMember);
router.post('/waive/:id', penaltyController.waivePenalty);
router.get('/member/:memberId', penaltyController.getMemberPenalties);

module.exports = router;
