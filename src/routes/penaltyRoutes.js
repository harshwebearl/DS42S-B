const express = require('express');
const router = express.Router();
const penaltyController = require('../controllers/penaltyController');
const { authDirector } = require('../middleware/auth');

router.use(authDirector);

router.post('/masters', penaltyController.createPenaltyMaster);
router.get('/masters', penaltyController.getPenaltyMasters);
router.put('/masters/:id', penaltyController.updatePenaltyMaster);
router.patch('/masters/:id/status', penaltyController.togglePenaltyMasterStatus);
router.delete('/masters/:id', penaltyController.deletePenaltyMaster);
router.post('/assign', penaltyController.assignPenaltyToMember);
router.post('/waive/:id', penaltyController.waivePenalty);
router.get('/member/:memberId', penaltyController.getMemberPenalties);

module.exports = router;
