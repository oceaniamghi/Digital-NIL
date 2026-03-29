import mongoose from 'mongoose';

const activitySchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: {
    type: String,
    enum: [
      'deal_offer',
      'deal_applied',
      'deal_accepted',
      'deal_declined',
      'deal_completed',
      'content_submitted',
      'content_approved',
      'content_rejected',
      'content_posted',
      'payment_received',
      'campaign_launched',
      'campaign_completed',
      'social_connected',
      'profile_verified'
    ],
    required: true
  },
  title: { type: String, required: true },
  message: { type: String, default: '' },
  data: { type: mongoose.Schema.Types.Mixed, default: {} },
  read: { type: Boolean, default: false },
  relatedDeal: { type: mongoose.Schema.Types.ObjectId, ref: 'Deal' },
  relatedCampaign: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign' },
  relatedContent: { type: mongoose.Schema.Types.ObjectId, ref: 'Content' },
  createdAt: { type: Date, default: Date.now }
});

export default mongoose.model('Activity', activitySchema);
