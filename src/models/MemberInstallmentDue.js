const mongoose = require('mongoose');

const memberInstallmentDueSchema = new mongoose.Schema({
  dueId: {
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
  installmentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'InstallmentMaster',
    required: true
  },
  financialYearId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'FinancialYear',
    required: true
  },
  originalAmountPaise: {
    type: Number,
    required: true,
    min: 0
  },
  paidAmountPaise: {
    type: Number,
    default: 0,
    min: 0
  },
  outstandingAmountPaise: {
    type: Number,
    required: true,
    min: 0
  },
  status: {
    type: String,
    enum: ['PENDING', 'PARTIAL', 'PAID', 'OVERDUE'],
    default: 'PENDING'
  },
  dueDate: {
    type: Date,
    required: true
  },
  lastPaymentDate: {
    type: Date
  }
}, {
  timestamps: true
});

// Prevent duplicate dues for the same member and installment
memberInstallmentDueSchema.index({ memberId: 1, installmentId: 1 }, { unique: true });
memberInstallmentDueSchema.index({ memberId: 1, status: 1 });
memberInstallmentDueSchema.index({ financialYearId: 1, status: 1 });

module.exports = mongoose.model('MemberInstallmentDue', memberInstallmentDueSchema);
