const mongoose = require('mongoose');

const claimChequeSchema = new mongoose.Schema({
  claimChequeId: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    uppercase: true
  },
  claimId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'DeathClaim',
    required: true
  },
  memberId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Member',
    required: true
  },
  beneficiaryName: {
    type: String,
    required: true,
    trim: true
  },
  chequeAmountPaise: {
    type: Number,
    required: true,
    min: 1
  },
  bankName: {
    type: String,
    required: true,
    trim: true
  },
  bankAccountNumber: {
    type: String,
    required: true,
    trim: true
  },
  chequeNumber: {
    type: String,
    required: true,
    trim: true
  },
  issueDate: {
    type: Date,
    required: true,
    default: Date.now
  },
  handoverDate: {
    type: Date
  },
  handoverRecipientName: {
    type: String,
    trim: true
  },
  handoverRecipientPhone: {
    type: String,
    trim: true
  },
  handoverAckDocumentPath: {
    type: String,
    trim: true
  },
  clearanceDate: {
    type: Date
  },
  chequeStatus: {
    type: String,
    enum: ['PREPARED', 'ISSUED', 'HANDED_OVER', 'DEPOSITED', 'CLEARED', 'RETURNED', 'CANCELLED'],
    default: 'PREPARED'
  },
  remarks: {
    type: String,
    trim: true
  }
}, {
  timestamps: true
});

claimChequeSchema.index({ claimId: 1 });
claimChequeSchema.index({ chequeStatus: 1 });

module.exports = mongoose.model('ClaimCheque', claimChequeSchema);
