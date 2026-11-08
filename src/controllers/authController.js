const jwt = require('jsonwebtoken');
const Director = require('../models/Director');
const { JWT_SECRET } = require('../middleware/auth');
const { logAuditEvent } = require('../middleware/audit');

// Director Login
async function login(req, res, next) {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Please provide email and password.' });
    }

    const director = await Director.findOne({ email: email.toLowerCase().trim() });
    if (!director || !director.isActive) {
      return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    }

    const isMatch = await director.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    }

    director.lastLogin = new Date();
    await director.save();

    const token = jwt.sign({ id: director._id, email: director.email }, JWT_SECRET, {
      expiresIn: '7d'
    });

    await logAuditEvent({
      req,
      action: 'DIRECTOR_LOGIN',
      entityType: 'Director',
      entityId: director._id,
      details: { email: director.email },
      performedBy: director._id
    });

    res.json({
      success: true,
      message: 'Login successful',
      token,
      director: {
        id: director._id,
        name: director.name,
        email: director.email,
        phone: director.phone,
        lastLogin: director.lastLogin
      }
    });
  } catch (err) {
    next(err);
  }
}

// Get Profile
async function getProfile(req, res, next) {
  try {
    const director = await Director.findById(req.director._id).select('-passwordHash');
    res.json({ success: true, director });
  } catch (err) {
    next(err);
  }
}

// Update Profile
async function updateProfile(req, res, next) {
  try {
    const { name, phone } = req.body;
    const director = await Director.findById(req.director._id);
    if (name) director.name = name.trim();
    if (phone) director.phone = phone.trim();
    await director.save();

    await logAuditEvent({
      req,
      action: 'DIRECTOR_PROFILE_UPDATED',
      entityType: 'Director',
      entityId: director._id,
      details: { name, phone }
    });

    res.json({
      success: true,
      message: 'Profile updated successfully',
      director: {
        id: director._id,
        name: director.name,
        email: director.email,
        phone: director.phone
      }
    });
  } catch (err) {
    next(err);
  }
}

// Change Password
async function changePassword(req, res, next) {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ success: false, message: 'Please provide current and new password.' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, message: 'New password must be at least 6 characters.' });
    }

    const director = await Director.findById(req.director._id);
    const isMatch = await director.comparePassword(currentPassword);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: 'Current password does not match.' });
    }

    director.passwordHash = await Director.hashPassword(newPassword);
    await director.save();

    await logAuditEvent({
      req,
      action: 'DIRECTOR_PASSWORD_CHANGED',
      entityType: 'Director',
      entityId: director._id,
      details: { email: director.email }
    });

    res.json({ success: true, message: 'Password changed successfully.' });
  } catch (err) {
    next(err);
  }
}

// Forgot / Reset Password flow
async function forgotPassword(req, res, next) {
  try {
    const { email } = req.body;
    const director = await Director.findOne({ email: email.toLowerCase().trim() });
    if (!director) {
      // Do not disclose whether email exists
      return res.json({ success: true, message: 'If an account exists with this email, a reset code has been processed.' });
    }

    const resetToken = Math.floor(100000 + Math.random() * 900000).toString(); // 6 digit code
    director.resetPasswordToken = resetToken;
    director.resetPasswordExpires = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes
    await director.save();

    await logAuditEvent({
      req,
      action: 'PASSWORD_RESET_REQUESTED',
      entityType: 'Director',
      entityId: director._id,
      details: { email }
    });

    res.json({
      success: true,
      message: 'Password reset code generated.',
      // For local development convenience and verification:
      resetCode: resetToken
    });
  } catch (err) {
    next(err);
  }
}

async function resetPassword(req, res, next) {
  try {
    const { email, resetCode, newPassword } = req.body;
    if (!email || !resetCode || !newPassword) {
      return res.status(400).json({ success: false, message: 'Please provide email, reset code, and new password.' });
    }

    const director = await Director.findOne({
      email: email.toLowerCase().trim(),
      resetPasswordToken: resetCode,
      resetPasswordExpires: { $gt: new Date() }
    });

    if (!director) {
      return res.status(400).json({ success: false, message: 'Invalid or expired reset code.' });
    }

    director.passwordHash = await Director.hashPassword(newPassword);
    director.resetPasswordToken = undefined;
    director.resetPasswordExpires = undefined;
    await director.save();

    await logAuditEvent({
      req,
      action: 'PASSWORD_RESET_COMPLETED',
      entityType: 'Director',
      entityId: director._id,
      details: { email }
    });

    res.json({ success: true, message: 'Password reset successfully. You can now login.' });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  login,
  getProfile,
  updateProfile,
  changePassword,
  forgotPassword,
  resetPassword
};
