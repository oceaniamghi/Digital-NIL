import mongoose from 'mongoose';

// One row per person an athlete refers. Created (status:pending) when a new user
// signs up via a referral code; flips to qualified (and pays out credits) when that
// user converts to a PAID plan or pays the sign-up fee. Earning on PAID conversion
// — not mere signup — keeps the program abuse-resistant.

export const REFERRAL_STATUSES = ['pending', 'qualified'];

const referralSchema = new mongoose.Schema({
  referrer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  referredUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  referredRole: { type: String, enum: ['athlete', 'coach'], default: 'athlete' }, // only these two earn credits
  status: { type: String, enum: REFERRAL_STATUSES, default: 'pending' },
  creditsAwarded: { type: Number, default: 0 },
  qualifiedAt: { type: Date },
  createdAt: { type: Date, default: Date.now }
});

export default mongoose.model('Referral', referralSchema);
