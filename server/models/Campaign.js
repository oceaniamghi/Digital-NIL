import mongoose from 'mongoose';

const campaignSchema = new mongoose.Schema({
  title: { type: String, required: true },
  description: { type: String, default: '' },
  brand: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  deals: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Deal' }],

  status: { type: String, enum: ['draft', 'active', 'paused', 'completed'], default: 'draft' },

  budget: { type: Number, default: 0 },
  spent: { type: Number, default: 0 },

  startDate: Date,
  endDate: Date,

  targetSports: [String],
  targetPlatforms: [{ type: String, enum: ['twitter', 'instagram', 'tiktok', 'youtube', 'facebook'] }],

  goals: {
    impressions: { type: Number, default: 0 },
    reach: { type: Number, default: 0 },
    engagements: { type: Number, default: 0 },
    deals: { type: Number, default: 0 }
  },

  metrics: {
    impressions: { type: Number, default: 0 },
    reach: { type: Number, default: 0 },
    engagements: { type: Number, default: 0 },
    dealsCompleted: { type: Number, default: 0 }
  },

  coverImage: { type: String, default: '' },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

campaignSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

export default mongoose.model('Campaign', campaignSchema);
