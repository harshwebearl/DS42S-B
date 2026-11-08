const express = require('express');
const router = express.Router();
const installmentController = require('../controllers/installmentController');
const { authDirector } = require('../middleware/auth');

router.use(authDirector);

router.post('/', installmentController.createInstallment);
router.get('/', installmentController.getInstallments);
router.post('/:id/generate-dues', installmentController.generateMemberDues);
router.put('/:id', installmentController.updateInstallment);
router.delete('/:id', installmentController.deleteInstallment);
router.get('/member/:memberId/dues', installmentController.getMemberDues);

module.exports = router;
