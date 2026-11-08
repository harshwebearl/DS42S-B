const mongoose = require('mongoose');

const paymentApplicationSchema = new mongoose.Schema({
  applicationId: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    uppercase: true
  },
  allocationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PaymentAllocation',
    required: true
  },
  installmentDueId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'MemberInstallmentDue'
  },
  memberPenaltyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'MemberPenalty'
  },
  appliedAmountPaise: {
    type: Number,
    required: true,
    min: 1
  },
  status: {
    type: String,
    enum: ['PROVISIONAL', 'APPLIED', 'REVERTED'],
    required: true,
    default: 'PROVISIONAL'
  }
}, {
  timestamps: true
});

paymentApplicationSchema.index({ allocationId: 1 });
paymentApplicationSchema.index({ installmentDueId: 1 });

module.exports = mongoose.model('PaymentApplication', paymentApplicationSchema);
