const mongoose = require('mongoose');
const { maskAadhaar, maskPan } = require('../utils/masking');

const memberSchema = new mongoose.Schema({
  memberId: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    uppercase: true
  },
  fullName: {
    type: String,
    required: true,
    trim: true
  },
  mobileNumber: {
    type: String,
    trim: true
  },
  email: {
    type: String,
    trim: true,
    lowercase: true
  },
  villageId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Village',
    required: false
  },
  dob: {
    type: Date,
    required: false
  },
  joiningDate: {
    type: Date,
    default: Date.now
  },
  occupation: {
    type: String,
    trim: true
  },
  gender: {
    type: String,
    enum: ['MALE', 'FEMALE', 'OTHER'],
    default: 'MALE'
  },
  maritalStatus: {
    type: Boolean,
    default: true // true = Married (Yes), false = Unmarried (No)
  },
  address: {
    type: String,
    trim: true
  },
  panCard: {
    type: String,
    trim: true,
    uppercase: true
  },
  aadhaarCard: {
    type: String,
    trim: true
  },
  status: {
    type: String,
    enum: ['ACTIVE', 'INACTIVE', 'DECEASED'],
    default: 'ACTIVE'
  },
  deathDate: {
    type: Date
  },
  notes: {
    type: String,
    trim: true
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

memberSchema.virtual('maskedAadhaar').get(function() {
  return maskAadhaar(this.aadhaarCard);
});

memberSchema.virtual('maskedPan').get(function() {
  return maskPan(this.panCard);
});

module.exports = mongoose.model('Member', memberSchema);
