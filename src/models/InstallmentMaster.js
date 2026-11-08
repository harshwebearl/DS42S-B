const mongoose = require('mongoose');

const installmentMasterSchema = new mongoose.Schema({
  installmentId: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    uppercase: true
  },
  financialYearId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'FinancialYear',
    required: true
  },
  installmentTitle: {
    type: String,
    required: true,
    trim: true
  },
  installmentNumber: {
    type: Number,
    required: true,
    min: 1
  },
  amountPaise: {
    type: Number,
    required: true,
    min: 1
  },
  startDate: {
    type: Date
  },
  dueDate: {
    type: Date,
    required: true
  },
  description: {
    type: String,
    trim: true
  },
  status: {
    type: String,
    enum: ['ACTIVE', 'INACTIVE'],
    default: 'ACTIVE'
  },
  applicabilityRule: {
    type: String,
    enum: ['ALL_ACTIVE', 'VILLAGE_SPECIFIC'],
    default: 'ALL_ACTIVE'
  },
  targetVillages: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Village'
  }]
}, {
  timestamps: true
});

// Ensure unique installment number per financial year
installmentMasterSchema.index({ financialYearId: 1, installmentNumber: 1 }, { unique: true });

module.exports = mongoose.model('InstallmentMaster', installmentMasterSchema);
