const mongoose = require('mongoose');
const { maskAadhaar, maskPan } = require('../utils/masking');

const nomineeHistorySchema = new mongoose.Schema({
  action: String,
  changedAt: { type: Date, default: Date.now },
  changedBy: String,
  details: String
}, { _id: false });

const nomineeSchema = new mongoose.Schema({
  nomineeId: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    uppercase: true
  },
  memberId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Member',
    required: true
  },
  nomineeName: {
    type: String,
    required: true,
    trim: true
  },
  mobileNumber: {
    type: String,
    trim: true
  },
  relation: {
    type: String,
    required: true,
    enum: ['SPOUSE', 'SON', 'DAUGHTER', 'FATHER', 'MOTHER', 'BROTHER', 'SISTER', 'DAUGHTER_IN_LAW', 'OTHER']
  },
  aadhaarCard: {
    type: String,
    trim: true
  },
  panCard: {
    type: String,
    trim: true,
    uppercase: true
  },
  sharePercentage: {
    type: Number,
    default: 100,
    min: 1,
    max: 100
  },
  priority: {
    type: Number,
    default: 1
  },
  status: {
    type: String,
    enum: ['ACTIVE', 'INACTIVE'],
    default: 'ACTIVE'
  },
  historyNotes: [nomineeHistorySchema]
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

nomineeSchema.virtual('maskedAadhaar').get(function() {
  return maskAadhaar(this.aadhaarCard);
});

nomineeSchema.virtual('maskedPan').get(function() {
  return maskPan(this.panCard);
});

module.exports = mongoose.model('Nominee', nomineeSchema);
