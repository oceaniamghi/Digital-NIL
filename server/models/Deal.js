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

  // Compensation. `amount` is the gross deal value the brand pays. Digital NIL takes
  // a platform commission off the top on every deal; the athlete is paid the
  // remainder. The rate is set by the REPRESENTING AGENT's subscription tier (higher
  // tiers pay a smaller cut) and falls back to PLATFORM_FEE_RATE when there's no
  // agent. It's stamped onto the deal (at creation for preview, re-resolved at
  // completion) so historical payouts stay correct if a rate ever changes.
  compensation: {
    amount: { type: Number, required: true },
    type: { type: String, enum: ['flat', 'per_post', 'per_thousand_impressions', 'rev_share'], default: 'flat' },
    currency: { type: String, default: 'USD' }
  },
  platformFeeRate: { type: Number, default: 0.20 },

  // Escrow + payout state (Stripe Connect; see lib/payments.js). The brand funds the
  // gross into platform escrow while the deal is active; on completion the athlete's
  // NET is transferred to their connected account and the platform keeps the fee.
  //   unfunded → funding → escrowed → released   (or → refunded)
  // `fee`/`net` are frozen at release so historical payouts stay correct.
  payment: {
    status: { type: String, enum: ['unfunded', 'funding', 'escrowed', 'released', 'refunded'], default: 'unfunded' },
    intentId: { type: String, default: '' },     // Stripe PaymentIntent (escrow charge)
    transferId: { type: String, default: '' },   // Stripe Transfer (athlete payout)
    amount: { type: Number, default: 0 },         // gross escrowed
    fee: { type: Number, default: 0 },            // platform fee retained at release
    net: { type: Number, default: 0 },            // athlete net paid out
    simulated: { type: Boolean, default: false }, // true when run in dev (no live Stripe)
    fundedAt: { type: Date },
    releasedAt: { type: Date }
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

  // Elite-only add-on: a brand-funded recruitment trip bundled into the deal
  // (e.g. flying an athlete out for an appearance/visit). Gated server-side to
  // brands whose plan has the `recruitmentTrips` capability.
  recruitmentTrip: {
    included: { type: Boolean, default: false },
    budget: { type: Number, default: 0 },
    notes: { type: String, default: '' }
  },

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

// Default/fallback platform service fee when a deal has no representing agent to set
// a tiered rate. Per-deal rates are resolved from the agent's plan (see plans.js).
export const PLATFORM_FEE_RATE = 0.20;

// Helpers so the fee math is identical everywhere it's computed/displayed.
export const platformFeeOn = (amount, rate = PLATFORM_FEE_RATE) =>
  Math.round((Number(amount) || 0) * rate);
export const athleteNetOf = (amount, rate = PLATFORM_FEE_RATE) =>
  (Number(amount) || 0) - platformFeeOn(amount, rate);

// Surface the breakdown on every serialized deal: gross (compensation.amount),
// the service fee Digital NIL keeps, and the athlete's net payout.
dealSchema.virtual('platformFee').get(function () {
  return platformFeeOn(this.compensation?.amount, this.platformFeeRate ?? PLATFORM_FEE_RATE);
});
dealSchema.virtual('athleteNet').get(function () {
  return athleteNetOf(this.compensation?.amount, this.platformFeeRate ?? PLATFORM_FEE_RATE);
});
dealSchema.set('toJSON', { virtuals: true });
dealSchema.set('toObject', { virtuals: true });

export default mongoose.model('Deal', dealSchema);
