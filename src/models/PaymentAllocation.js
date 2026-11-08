const mongoose = require('mongoose');

const paymentAllocationSchema = new mongoose.Schema({
  allocationId: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    uppercase: true
  },
  transactionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PaymentTransaction',
    required: true
  },
  memberId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Member',
    required: true
  },
  allocatedAmountPaise: {
    type: Number,
    required: true,
    min: 1
  },
  status: {
    type: String,
    enum: ['PROVISIONAL', 'CONFIRMED', 'REVERTED', 'CANCELLED'],
    required: true,
    default: 'PROVISIONAL'
  },
  notes: {
    type: String,
    trim: true
  }
}, {
  timestamps: true
});

paymentAllocationSchema.index({ transactionId: 1, memberId: 1 });
paymentAllocationSchema.index({ memberId: 1, status: 1 });

module.exports = mongoose.model('PaymentAllocation', paymentAllocationSchema);
