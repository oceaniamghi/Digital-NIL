import mongoose from 'mongoose';

// Mirrors the deliverable shape in Deal.js so a converted opportunity maps cleanly.
const deliverableSchema = new mongoose.Schema({
  type: { type: String, enum: ['post', 'story', 'video', 'reel', 'tweet', 'appearance', 'other'], default: 'post' },
  platform: { type: String, enum: ['twitter', 'instagram', 'tiktok', 'youtube', 'facebook', 'any'], default: 'any' },
  description: String
}, { _id: true });

export const STAGES = ['prospect', 'pitched', 'negotiating', 'contract_out', 'signed', 'active', 'lost'];

// Default win-probability per stage; applied on stage change.
export const STAGE_PROBABILITY = {
  prospect: 10, pitched: 25, negotiating: 50, contract_out: 75, signed: 90, active: 100, lost: 0
};

const opportunitySchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true },
  company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  primaryContact: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact' },
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

  stage: { type: String, enum: STAGES, default: 'prospect' },
  value: { type: Number, default: 0 },
  commissionPct: { type: Number, default: 0 },
  probability: { type: Number, default: 10 },

  sports: [String],
  platforms: [{ type: String, enum: ['twitter', 'instagram', 'tiktok', 'youtube', 'facebook', 'any'] }],
  targetAthletes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  deliverables: [deliverableSchema],

  expectedCloseDate: { type: Date },
  source: { type: String, enum: ['inbound', 'referral', 'outbound', 'marketplace', 'other'], default: 'outbound' },
  lostReason: { type: String, default: '' },

  stageEnteredAt: { type: Date, default: Date.now },
  linkedDeal: { type: mongoose.Schema.Types.ObjectId, ref: 'Deal', default: null },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

opportunitySchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

export default mongoose.model('Opportunity', opportunitySchema);
