const express = require('express');
const router = express.Router();
const villageController = require('../controllers/villageController');
const { authDirector } = require('../middleware/auth');

router.use(authDirector);

router.post('/bulk-status', villageController.bulkUpdateVillageStatus);
router.post('/bulk-delete', villageController.bulkDeleteVillages);

router.post('/', villageController.createVillage);
router.get('/', villageController.getVillages);
router.get('/:id', villageController.getVillageById);
router.put('/:id', villageController.updateVillage);
router.patch('/:id/toggle-status', villageController.deactivateVillage);
router.delete('/:id', villageController.deleteVillage);

module.exports = router;
