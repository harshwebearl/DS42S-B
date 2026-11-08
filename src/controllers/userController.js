const Director = require('../models/Director');
const { logAuditEvent } = require('../middleware/audit');

// Get All Directors / Users
async function getUsers(req, res, next) {
  try {
    const users = await Director.find()
      .select('-passwordHash -resetPasswordToken -resetPasswordExpires')
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      count: users.length,
      users
    });
  } catch (err) {
    next(err);
  }
}

// Create New Director
async function createUser(req, res, next) {
  try {
    const { name, email, password, phone, designation, role, isActive } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Director name is required.' });
    }

    if (!email || !email.trim()) {
      return res.status(400).json({ success: false, message: 'Login Email ID is required.' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email.trim())) {
      return res.status(400).json({ success: false, message: 'Please provide a valid email address.' });
    }

    if (!password || password.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters long.' });
    }

    const cleanEmail = email.toLowerCase().trim();
    const existing = await Director.findOne({ email: cleanEmail });
    if (existing) {
      return res.status(400).json({
        success: false,
        message: `A Director with email '${cleanEmail}' already exists.`
      });
    }

    const passwordHash = await Director.hashPassword(password);

    const user = await Director.create({
      name: name.trim(),
      email: cleanEmail,
      passwordHash,
      phone: phone ? phone.trim() : '',
      designation: designation ? designation.trim() : 'Director',
      role: role || 'DIRECTOR',
      isActive: isActive !== undefined ? Boolean(isActive) : true
    });

    await logAuditEvent({
      req,
      action: 'DIRECTOR_CREATED',
      entityType: 'Director',
      entityId: user._id,
      details: { name: user.name, email: user.email, role: user.role }
    });

    const userObj = user.toObject();
    delete userObj.passwordHash;

    res.status(201).json({
      success: true,
      message: `Director account for '${user.name}' created successfully.`,
      user: userObj
    });
  } catch (err) {
    next(err);
  }
}

// Update Director
async function updateUser(req, res, next) {
  try {
    const { id } = req.params;
    const { name, email, password, phone, designation, role, isActive } = req.body;

    const user = await Director.findById(id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'Director not found.' });
    }

    if (name) user.name = name.trim();
    if (phone !== undefined) user.phone = phone ? phone.trim() : '';
    if (designation) user.designation = designation.trim();
    if (role) user.role = role;

    // Email update check
    if (email && email.toLowerCase().trim() !== user.email) {
      const cleanEmail = email.toLowerCase().trim();
      const emailExists = await Director.findOne({ email: cleanEmail, _id: { $ne: id } });
      if (emailExists) {
        return res.status(400).json({ success: false, message: `Email '${cleanEmail}' is already used by another Director.` });
      }
      user.email = cleanEmail;
    }

    // Password update
    if (password && password.trim()) {
      if (password.length < 6) {
        return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
      }
      user.passwordHash = await Director.hashPassword(password);
    }

    // Active status change
    if (isActive !== undefined) {
      if (req.director._id.toString() === id && isActive === false) {
        return res.status(400).json({
          success: false,
          message: 'You cannot deactivate your own logged-in Director account.'
        });
      }
      user.isActive = Boolean(isActive);
    }

    await user.save();

    await logAuditEvent({
      req,
      action: 'DIRECTOR_UPDATED',
      entityType: 'Director',
      entityId: user._id,
      details: { name: user.name, email: user.email, isActive: user.isActive, passwordChanged: Boolean(password) }
    });

    const userObj = user.toObject();
    delete userObj.passwordHash;

    res.json({
      success: true,
      message: `Director '${user.name}' updated successfully.`,
      user: userObj
    });
  } catch (err) {
    next(err);
  }
}

// Toggle Director Active / Inactive Status
async function toggleUserStatus(req, res, next) {
  try {
    const { id } = req.params;

    if (req.director._id.toString() === id) {
      return res.status(400).json({
        success: false,
        message: 'You cannot deactivate your own logged-in Director account.'
      });
    }

    const user = await Director.findById(id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'Director not found.' });
    }

    user.isActive = !user.isActive;
    await user.save();

    await logAuditEvent({
      req,
      action: 'DIRECTOR_STATUS_CHANGED',
      entityType: 'Director',
      entityId: user._id,
      details: { name: user.name, email: user.email, newStatus: user.isActive ? 'ACTIVE' : 'INACTIVE' }
    });

    res.json({
      success: true,
      message: `Director '${user.name}' marked as ${user.isActive ? 'ACTIVE' : 'INACTIVE'}.`,
      isActive: user.isActive
    });
  } catch (err) {
    next(err);
  }
}

// Delete Director
async function deleteUser(req, res, next) {
  try {
    const { id } = req.params;

    if (req.director._id.toString() === id) {
      return res.status(400).json({
        success: false,
        message: 'You cannot delete your own logged-in Director account.'
      });
    }

    const user = await Director.findById(id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'Director not found.' });
    }

    if (user.isActive) {
      const activeCount = await Director.countDocuments({ isActive: true });
      if (activeCount <= 1) {
        return res.status(400).json({
          success: false,
          message: 'Cannot delete the only remaining active Director account in the system.'
        });
      }
    }

    await user.deleteOne();

    await logAuditEvent({
      req,
      action: 'DIRECTOR_DELETED',
      entityType: 'Director',
      entityId: user._id,
      details: { name: user.name, email: user.email }
    });

    res.json({
      success: true,
      message: `Director account '${user.name}' (${user.email}) deleted successfully.`
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getUsers,
  createUser,
  updateUser,
  toggleUserStatus,
  deleteUser
};