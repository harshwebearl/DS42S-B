const mongoose = require('mongoose');

const ledgerEntrySchema = new mongoose.Schema({
  ledgerId: {
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
  transactionDate: {
    type: Date,
    required: true,
    default: Date.now
  },
  entryType: {
    type: String,
    enum: [
      'INSTALLMENT_DUE',
      'PAYMENT',
      'BULK_PAYMENT',
      'PENALTY',
      'PENALTY_WAIVER',
      'REALLOCATION_ADJUSTMENT',
      'CHEQUE_BOUNCE_REVERSAL'
    ],
    required: true
  },
  referenceId: {
    type: String,
    trim: true
  },
  description: {
    type: String,
    required: true,
    trim: true
  },
  debitPaise: {
    type: Number,
    default: 0,
    min: 0
  },
  creditPaise: {
    type: Number,
    default: 0,
    min: 0
  },
  runningBalancePaise: {
    type: Number,
    required: true
  },
  status: {
    type: String,
    enum: ['POSTED', 'PROVISIONAL', 'REVERSED'],
    default: 'POSTED'
  },
  financialYearId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'FinancialYear'
  }
}, {
  timestamps: true
});

ledgerEntrySchema.index({ memberId: 1, transactionDate: 1, createdAt: 1 });

module.exports = mongoose.model('LedgerEntry', ledgerEntrySchema);
