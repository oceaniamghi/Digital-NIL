import mongoose from 'mongoose';

// Affiliate reward catalog. Priced in referral CREDITS (athlete referral = 1 credit,
// coach = 2). `type` keeps the catalog extensible: only 'free_month' is implemented
// + seeded today (auto-fulfilled by extending planCompUntil); 'gear'/'memorabilia'
// are reserved for a future manually-shipped tier and stay inactive for now.

export const REWARD_TYPES = ['free_month', 'gear', 'memorabilia'];

const rewardSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },   // stable id e.g. 'free_month_1'
  name: { type: String, required: true },
  description: { type: String, default: '' },
  type: { type: String, enum: REWARD_TYPES, default: 'free_month' },
  creditsCost: { type: Number, required: true },         // referral credits to redeem
  months: { type: Number, default: 0 },                  // free paid months granted (free_month type)
  active: { type: Boolean, default: true },
  order: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

export default mongoose.model('Reward', rewardSchema);
