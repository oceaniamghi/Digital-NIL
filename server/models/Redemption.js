import mongoose from 'mongoose';

// A redeemed reward. free_month redemptions auto-apply (status 'applied') by
// extending the athlete's planCompUntil; physical types (future) would land as
// 'pending_fulfillment' for an admin to ship.

export const REDEMPTION_STATUSES = ['applied', 'pending_fulfillment', 'shipped', 'cancelled'];

const redemptionSchema = new mongoose.Schema({
  athlete: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  reward: { type: mongoose.Schema.Types.ObjectId, ref: 'Reward', required: true },
  rewardName: { type: String, default: '' },
  type: { type: String, default: 'free_month' },
  creditsSpent: { type: Number, required: true },
  monthsGranted: { type: Number, default: 0 },
  compUntil: { type: Date },                 // resulting comp expiry after this redemption
  status: { type: String, enum: REDEMPTION_STATUSES, default: 'applied' },
  createdAt: { type: Date, default: Date.now }
});

export default mongoose.model('Redemption', redemptionSchema);
