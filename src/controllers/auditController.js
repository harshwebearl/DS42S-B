const AuditLog = require('../models/AuditLog');

async function getAuditLogs(req, res, next) {
  try {
    const { action, entityType, page = 1, limit = 50 } = req.query;
    const filter = {};

    if (action) filter.action = action;
    if (entityType) filter.entityType = entityType;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const total = await AuditLog.countDocuments(filter);

    const logs = await AuditLog.find(filter)
      .populate('performedBy', 'name email')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    res.json({
      success: true,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / parseInt(limit)),
      logs
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getAuditLogs
};
