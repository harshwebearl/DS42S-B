const express = require('express');
const router = express.Router();
const nomineeController = require('../controllers/nomineeController');
const { authDirector } = require('../middleware/auth');

router.use(authDirector);

router.post('/', nomineeController.createNominee);
router.get('/member/:memberId', nomineeController.getNomineesByMember);
router.put('/:id', nomineeController.updateNominee);
router.patch('/:id/toggle-status', nomineeController.deactivateNominee);

module.exports = router;
