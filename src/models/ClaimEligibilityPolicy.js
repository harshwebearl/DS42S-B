const mongoose = require('mongoose');

const claimEligibilityPolicySchema = new mongoose.Schema({
  policyCode: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    uppercase: true
  },
  policyTitle: {
    type: String,
    required: true,
    trim: true
  },
  effectiveDate: {
    type: Date,
    required: true,
    default: Date.now
  },
  minMembershipMonths: {
    type: Number,
    default: 0
  },
  // Strict business rule: member must not have unpaid required installments to proceed to cheque issuance
  pendingInstallmentRule: {
    type: String,
    enum: ['STRICT_ZERO_DUES', 'ALLOW_DEDUCTION'],
    default: 'STRICT_ZERO_DUES'
  },
  penaltyEligibilityRule: {
    type: String,
    enum: ['NO_UNPAID_PENALTIES', 'ALLOW_PENALTY_DEDUCTION'],
    default: 'NO_UNPAID_PENALTIES'
  },
  claimAmountType: {
    type: String,
    enum: ['FIXED', 'CONFIGURABLE'],
    default: 'FIXED'
  },
  defaultClaimAmountPaise: {
    type: Number,
    required: true,
    min: 0,
    default: 10000000 // ₹1,00,000 default assistance
  },
  requiredDocuments: [{
    type: String,
    trim: true
  }],
  status: {
    type: String,
    enum: ['ACTIVE', 'INACTIVE'],
    default: 'ACTIVE'
  },
  notes: {
    type: String,
    trim: true
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('ClaimEligibilityPolicy', claimEligibilityPolicySchema);
