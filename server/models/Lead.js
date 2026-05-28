import mongoose from 'mongoose';

export const LEAD_STATUSES = ['new', 'working', 'nurturing', 'qualified', 'unqualified', 'converted'];
export const LEAD_RATINGS = ['hot', 'warm', 'cold'];
export const LEAD_SOURCES = ['inbound', 'referral', 'outbound', 'marketplace', 'event', 'social', 'other'];

// Simple Salesforce-style lead score (0–100): rating sets the floor, filled
// contactability/fit fields add points. Kept identical on the client preview.
export function computeLeadScore(lead = {}) {
  let s = { hot: 55, warm: 35, cold: 15 }[lead.rating] ?? 35;
  if (lead.email) s += 15;
  if (lead.phone) s += 10;
  if (lead.company) s += 10;
  if (lead.title) s += 5;
  if (lead.sport) s += 5;
  return Math.min(100, s);
}

const leadSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  company: { type: String, default: '' },   // free text — not yet an Account
  email: { type: String, default: '', lowercase: true, trim: true },
  phone: { type: String, default: '' },
  title: { type: String, default: '' },
  sport: { type: String, default: '' },
  notes: { type: String, default: '' },
  tags: [{ type: String }],

  source: { type: String, enum: LEAD_SOURCES, default: 'inbound' },
  status: { type: String, enum: LEAD_STATUSES, default: 'new' },
  rating: { type: String, enum: LEAD_RATINGS, default: 'warm' },
  score: { type: Number, default: 35 },

  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

  // Set on conversion
  convertedAt: { type: Date },
  convertedCompany: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', default: null },
  convertedContact: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact', default: null },
  convertedOpportunity: { type: mongoose.Schema.Types.ObjectId, ref: 'Opportunity', default: null },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

leadSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  this.score = computeLeadScore(this);
  next();
});

export default mongoose.model('Lead', leadSchema);
