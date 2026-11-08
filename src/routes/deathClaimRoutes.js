const express = require('express');
const router = express.Router();
const deathClaimController = require('../controllers/deathClaimController');
const { authDirector } = require('../middleware/auth');
const upload = require('../middleware/upload');

router.use(authDirector);

router.post('/check-eligibility', deathClaimController.checkEligibility);
router.post('/', upload.single('deathCertificate'), deathClaimController.createDeathClaim);
router.get('/', deathClaimController.getDeathClaims);
router.get('/:id', deathClaimController.getDeathClaimById);
router.post('/:id/review', deathClaimController.reviewClaim);

module.exports = router;
