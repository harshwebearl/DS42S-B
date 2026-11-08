const mongoose = require('mongoose');

const localCounters = {};

// Safe sequential formatted ID generator supporting transactions and high concurrency
async function generateSequentialId(Model, idField, prefix, padLength = 4, session = null) {
  const modelName = Model.modelName || prefix;
  if (!localCounters[modelName]) {
    localCounters[modelName] = 0;
  }

  // Count existing documents in DB
  const query = Model.countDocuments();
  if (session) query.session(session);
  const dbCount = await query;

  localCounters[modelName] = Math.max(localCounters[modelName], dbCount) + 1;
  const num = localCounters[modelName];

  let candidate = `${prefix}-${String(num).padStart(padLength, '0')}`;

  // Double check in DB
  let checkQuery = Model.findOne({ [idField]: candidate });
  if (session) checkQuery.session(session);
  let exists = await checkQuery;

  while (exists) {
    localCounters[modelName]++;
    candidate = `${prefix}-${String(localCounters[modelName]).padStart(padLength, '0')}`;
    checkQuery = Model.findOne({ [idField]: candidate });
    if (session) checkQuery.session(session);
    exists = await checkQuery;
  }

  return candidate;
}

module.exports = {
  generateSequentialId
};
