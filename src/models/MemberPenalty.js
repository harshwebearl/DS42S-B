const mongoose = require('mongoose');

const memberPenaltySchema = new mongoose.Schema({
  memberPenaltyId: {
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
  penaltyMasterId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PenaltyMaster'
  },
  installmentDueId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'MemberInstallmentDue'
  },
  title: {
    type: String,
    required: true,
    trim: true
  },
  amountPaise: {
    type: Number,
    required: true,
    min: 0
  },
  paidAmountPaise: {
    type: Number,
    default: 0,
    min: 0
  },
  waivedAmountPaise: {
    type: Number,
    default: 0,
    min: 0
  },
  outstandingAmountPaise: {
    type: Number,
    required: true,
    min: 0
  },
  waiverReason: {
    type: String,
    trim: true
  },
  waivedAt: {
    type: Date
  },
  waivedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Director'
  },
  status: {
    type: String,
    enum: ['PENDING', 'PAID', 'PARTIAL', 'WAIVED'],
    default: 'PENDING'
  },
  reason: {
    type: String,
    trim: true
  }
}, {
  timestamps: true
});

memberPenaltySchema.index({ memberId: 1, status: 1 });

module.exports = mongoose.model('MemberPenalty', memberPenaltySchema);
