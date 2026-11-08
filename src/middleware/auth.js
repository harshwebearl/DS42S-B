const jwt = require('jsonwebtoken');
const Director = require('../models/Director');

const JWT_SECRET = process.env.JWT_SECRET || 'ds24g_director_super_secret_jwt_key_2026';

async function authDirector(req, res, next) {
  try {
    const authHeader = req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: 'Access denied. No authentication token provided.'
      });
    }

    const token = authHeader.replace('Bearer ', '').trim();
    const decoded = jwt.verify(token, JWT_SECRET);

    const director = await Director.findById(decoded.id).select('-passwordHash');
    if (!director || !director.isActive) {
      return res.status(401).json({
        success: false,
        message: 'Invalid session or account deactivated. Please log in again.'
      });
    }

    req.director = director;
    next();
  } catch (err) {
    return res.status(401).json({
      success: false,
      message: 'Invalid or expired authentication token.',
      error: err.message
    });
  }
}

module.exports = {
  authDirector,
  JWT_SECRET
};
