const mongoose = require('mongoose');

const villageSchema = new mongoose.Schema({
  villageId: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    uppercase: true
  },
  name: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },
  taluka: {
    type: String,
    trim: true
  },
  district: {
    type: String,
    trim: true,
    default: 'Bhavnagar'
  },
  state: {
    type: String,
    trim: true,
    default: 'Gujarat'
  },
  status: {
    type: String,
    enum: ['ACTIVE', 'INACTIVE'],
    default: 'ACTIVE'
  },
  description: {
    type: String,
    trim: true
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('Village', villageSchema);
