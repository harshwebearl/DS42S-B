const mongoose = require('mongoose');

const financialYearSchema = new mongoose.Schema({
  fyCode: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    uppercase: true
  },
  yearName: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },
  startDate: {
    type: Date,
    required: true
  },
  endDate: {
    type: Date,
    required: true
  },
  status: {
    type: String,
    enum: ['ACTIVE', 'INACTIVE', 'CLOSED'],
    default: 'ACTIVE'
  },
  isCurrent: {
    type: Boolean,
    default: false
  },
  description: {
    type: String,
    trim: true
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('FinancialYear', financialYearSchema);
