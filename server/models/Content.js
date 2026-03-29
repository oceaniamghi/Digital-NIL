import mongoose from 'mongoose';

const platformMetricSchema = new mongoose.Schema({
  platform: String,
  impressions: { type: Number, default: 0 },
  clicks: { type: Number, default: 0 },
  likes: { type: Number, default: 0 },
  shares: { type: Number, default: 0 },
  comments: { type: Number, default: 0 },
  reach: { type: Number, default: 0 }
}, { _id: false });

const contentSchema = new mongoose.Schema({
  title: { type: String, required: true },
  caption: { type: String, default: '' },
  hashtags: [String],
  disclosureTag: { type: String, default: '#ad' },

  deal: { type: mongoose.Schema.Types.ObjectId, ref: 'Deal' },
  campaign: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  brand: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  type: { type: String, enum: ['image', 'video', 'text', 'carousel', 'story'], default: 'image' },
  fileUrl: { type: String, default: '' },
  thumbnailUrl: { type: String, default: '' },
  mimeType: { type: String, default: '' },
  fileSize: { type: Number, default: 0 },

  platforms: [{ type: String, enum: ['twitter', 'instagram', 'tiktok', 'youtube', 'facebook'] }],

  status: {
    type: String,
    enum: ['draft', 'pending_review', 'approved', 'posted', 'rejected'],
    default: 'draft'
  },
  rejectionReason: { type: String, default: '' },

  scheduledAt: Date,
  postedAt: Date,

  metrics: [platformMetricSchema],

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

contentSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

export default mongoose.model('Content', contentSchema);
