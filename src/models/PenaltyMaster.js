const mongoose = require('mongoose');

const penaltyMasterSchema = new mongoose.Schema({
  penaltyId: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    uppercase: true
  },
  title: {
    type: String,
    required: true,
    trim: true
  },
  type: {
    type: String,
    enum: ['FIXED', 'PERCENTAGE'],
    default: 'FIXED'
  },
  // If FIXED, stored in paise. If PERCENTAGE, stored as percentage number (e.g. 5 for 5%)
  rateOrAmount: {
    type: Number,
    required: true,
    min: 0
  },
  applicableRule: {
    type: String,
    enum: ['MANUAL', 'AFTER_DUE_DATE', 'BOUNCED_CHEQUE'],
    default: 'MANUAL'
  },
  gracePeriodDays: {
    type: Number,
    default: 0
  },
  description: {
    type: String,
    trim: true
  },
  status: {
    type: String,
    enum: ['ACTIVE', 'INACTIVE'],
    default: 'ACTIVE'
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('PenaltyMaster', penaltyMasterSchema);
