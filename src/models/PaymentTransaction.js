const mongoose = require('mongoose');

const paymentTransactionSchema = new mongoose.Schema({
  transactionId: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    uppercase: true
  },
  isBulk: {
    type: Boolean,
    default: false
  },
  payerName: {
    type: String,
    required: true,
    trim: true
  },
  payerMobile: {
    type: String,
    trim: true
  },
  paymentDate: {
    type: Date,
    required: true,
    default: Date.now
  },
  paymentMode: {
    type: String,
    enum: ['CASH', 'UPI', 'BANK_TRANSFER', 'CHEQUE'],
    required: true
  },
  totalAmountPaise: {
    type: Number,
    required: true,
    min: 1
  },
  // Single payment target member (null if bulk)
  singleMemberId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Member'
  },
  financialYearId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'FinancialYear'
  },
  // Cheque details if mode == CHEQUE
  chequeDetails: {
    chequeNumber: { type: String, trim: true },
    bankName: { type: String, trim: true },
    bankAccountNumber: { type: String, trim: true },
    chequeDate: { type: Date },
    depositDate: { type: Date },
    clearanceDate: { type: Date },
    bounceDate: { type: Date },
    bounceReason: { type: String, trim: true },
    clearanceReference: { type: String, trim: true }
  },
  referenceNumber: {
    type: String,
    trim: true
  },
  paymentStatus: {
    type: String,
    enum: ['RECEIVED', 'DEPOSITED', 'CLEARED', 'BOUNCED', 'CANCELLED'],
    required: true,
    default: function() {
      return this.paymentMode === 'CHEQUE' ? 'RECEIVED' : 'CLEARED';
    }
  },
  remarks: {
    type: String,
    trim: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Director'
  }
}, {
  timestamps: true
});

paymentTransactionSchema.index({ paymentDate: -1 });
paymentTransactionSchema.index({ paymentStatus: 1 });
paymentTransactionSchema.index({ 'chequeDetails.chequeNumber': 1 });

module.exports = mongoose.model('PaymentTransaction', paymentTransactionSchema);
