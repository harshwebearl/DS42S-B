const mongoose = require('mongoose');

const deathClaimSchema = new mongoose.Schema({
  claimId: {
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
  dateOfDeath: {
    type: Date,
    required: true
  },
  deathCertificatePath: {
    type: String,
    trim: true
  },
  nomineeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Nominee'
  },
  nomineeName: {
    type: String,
    required: true,
    trim: true
  },
  nomineeRelation: {
    type: String,
    required: true,
    trim: true
  },
  nomineeMobile: {
    type: String,
    trim: true
  },
  nomineeAadhaar: {
    type: String,
    trim: true
  },
  nomineePan: {
    type: String,
    trim: true
  },
  registrationDate: {
    type: Date,
    default: Date.now
  },
  policyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ClaimEligibilityPolicy'
  },
  totalRequiredInstallmentsPaise: {
    type: Number,
    required: true,
    default: 0
  },
  confirmedPaidInstallmentsPaise: {
    type: Number,
    required: true,
    default: 0
  },
  pendingInstallmentsPaise: {
    type: Number,
    required: true,
    default: 0
  },
  pendingPenaltiesPaise: {
    type: Number,
    default: 0
  },
  eligibilityStatus: {
    type: String,
    enum: ['ELIGIBLE', 'INELIGIBLE_PENDING_DUES', 'INELIGIBLE_POLICY_CRITERIA'],
    required: true
  },
  eligibilityReason: {
    type: String,
    trim: true
  },
  claimStatus: {
    type: String,
    enum: ['PENDING_REVIEW', 'APPROVED', 'REJECTED', 'DISBURSED', 'CLOSED'],
    default: 'PENDING_REVIEW'
  },
  approvedAmountPaise: {
    type: Number,
    default: 0
  },
  approvalDate: {
    type: Date
  },
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Director'
  },
  approvalRemarks: {
    type: String,
    trim: true
  },
  rejectionReason: {
    type: String,
    trim: true
  }
}, {
  timestamps: true
});

deathClaimSchema.index({ memberId: 1 });
deathClaimSchema.index({ claimStatus: 1 });

module.exports = mongoose.model('DeathClaim', deathClaimSchema);
