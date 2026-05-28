import mongoose from 'mongoose';

const contactSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, default: '', lowercase: true, trim: true },
  phone: { type: String, default: '' },
  title: { type: String, default: '' },
  tags: [{ type: String }],
  notes: { type: String, default: '' },
  lastContactedAt: { type: Date },

  company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company' },
  linkedUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

contactSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

export default mongoose.model('Contact', contactSchema);
