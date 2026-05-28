import mongoose from 'mongoose';

const deliverableSchema = new mongoose.Schema({
  type: { type: String, enum: ['post', 'story', 'video', 'reel', 'tweet', 'appearance', 'other'], required: true },
  platform: { type: String, enum: ['twitter', 'instagram', 'tiktok', 'youtube', 'facebook', 'any'], default: 'any' },
  description: String,
  deadline: Date,
  status: { type: String, enum: ['pending', 'submitted', 'approved', 'posted'], default: 'pending' },
  contentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Content' }
}, { _id: true });

const dealSchema = new mongoose.Schema({
  title: { type: String, required: true },
  description: { type: String, required: true },
  brand: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  athlete: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  campaign: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign' },

  // Deal type & requirements
  type: { type: String, enum: ['social_post', 'video', 'appearance', 'licensing', 'ambassador', 'other'], default: 'social_post' },
  platforms: [{ type: String, enum: ['twitter', 'instagram', 'tiktok', 'youtube', 'facebook', 'any'] }],
  sports: [String],
  minFollowers: { type: Number, default: 0 },

  // Compensation
  compensation: {
    amount: { type: Number, required: true },
    type: { type: String, enum: ['flat', 'per_post', 'per_thousand_impressions', 'rev_share'], default: 'flat' },
    currency: { type: String, default: 'USD' }
  },

  // Status workflow: open → applied → active → completed / declined
  // 'offered' = a brand offered this deal to a specific athlete, awaiting their acceptance
  status: {
    type: String,
    enum: ['open', 'offered', 'applied', 'active', 'completed', 'declined', 'expired'],
    default: 'open'
  },
  offerMessage: { type: String, default: '' },

  // Deliverables
  deliverables: [deliverableSchema],
  disclosureTag: { type: String, default: '#ad' },

  // Applications (for open deals)
  applications: [{
    athlete: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    message: String,
    appliedAt: { type: Date, default: Date.now },
    status: { type: String, enum: ['pending', 'accepted', 'declined'], default: 'pending' }
  }],

  // Performance metrics
  metrics: {
    impressions: { type: Number, default: 0 },
    clicks: { type: Number, default: 0 },
    engagements: { type: Number, default: 0 },
    reach: { type: Number, default: 0 }
  },

  // Dates
  startDate: Date,
  endDate: Date,
  expiresAt: Date,

  // Visibility
  isPublic: { type: Boolean, default: true },
  featuredImage: { type: String, default: '' },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

dealSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

export default mongoose.model('Deal', dealSchema);
