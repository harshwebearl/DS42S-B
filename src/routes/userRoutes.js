const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const { authDirector } = require('../middleware/auth');

router.use(authDirector);

router.get('/', userController.getUsers);
router.post('/', userController.createUser);
router.put('/:id', userController.updateUser);
router.patch('/:id/status', userController.toggleUserStatus);
router.delete('/:id', userController.deleteUser);

module.exports = router;