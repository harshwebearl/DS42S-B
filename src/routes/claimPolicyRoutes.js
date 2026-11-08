const express = require('express');
const router = express.Router();
const claimPolicyController = require('../controllers/claimPolicyController');
const { authDirector } = require('../middleware/auth');

router.use(authDirector);

router.get('/', claimPolicyController.getPolicies);
router.get('/active', claimPolicyController.getActivePolicy);
router.post('/', claimPolicyController.createPolicy);

module.exports = router;
