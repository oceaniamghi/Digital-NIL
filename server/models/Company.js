import mongoose from 'mongoose';

const companySchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  type: { type: String, enum: ['brand', 'agency', 'other'], default: 'brand' },
  logo: { type: String, default: '' },
  domain: { type: String, default: '' },
  website: { type: String, default: '' },
  industry: { type: String, default: '' },
  location: { type: String, default: '' },
  notes: { type: String, default: '' },
  tags: [{ type: String }],

  // Onboarded brand account this CRM record maps to (required to convert to a Deal)
  linkedUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  // The agent who owns this relationship
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

companySchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

export default mongoose.model('Company', companySchema);
