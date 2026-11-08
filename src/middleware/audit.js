const AuditLog = require('../models/AuditLog');
const { generateSequentialId } = require('../utils/idGenerator');

async function logAuditEvent({ req, action, entityType, entityId, details, performedBy }) {
  try {
    const directorId = performedBy || (req && req.director ? req.director._id : null);
    const ipAddress = req ? (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1') : 'SYSTEM';
    const userAgent = req ? (req.headers['user-agent'] || 'API') : 'SYSTEM';

    const logId = await generateSequentialId(AuditLog, 'logId', 'LOG', 5);

    await AuditLog.create({
      logId,
      action,
      entityType,
      entityId: String(entityId || ''),
      details: details || {},
      ipAddress,
      userAgent,
      performedBy: directorId
    });
  } catch (err) {
    console.error('[Audit Log Error]', err.message);
  }
}

module.exports = {
  logAuditEvent
};
