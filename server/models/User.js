import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const socialHandleSchema = new mongoose.Schema({
  platform: { type: String, enum: ['twitter', 'instagram', 'tiktok', 'youtube', 'facebook'] },
  handle: String,
  followers: { type: Number, default: 0 },
  connected: { type: Boolean, default: false }
}, { _id: false });

// Athlete-built media-kit template items: uploaded files or external media links.
const mediaKitItemSchema = new mongoose.Schema({
  kind: { type: String, enum: ['file', 'link'], default: 'link' },
  url: { type: String, default: '' },
  label: { type: String, default: '' },
  mime: { type: String, default: '' }
}, { _id: false });

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true },
  name: { type: String, required: true, trim: true },
  role: { type: String, enum: ['athlete', 'brand', 'agent', 'coach', 'admin'], default: 'athlete' },
  avatar: { type: String, default: '' },
  bio: { type: String, default: '', maxlength: 500 },
  verified: { type: Boolean, default: false },
  managed: { type: Boolean, default: false }, // true = roster record created by an agent (data, not a billable login seat)
  lastLoginAt: { type: Date },
  phone: { type: String, default: '' },

  // Post-signup gate: email verification + onboarding (phone + card on file). A
  // freshly self-registered login is verified:false, onboarded:false and is held
  // on the verify → onboarding screens until both clear. Grandfathered legacy
  // accounts are migrated to true at boot (see server/index.js migrateGate()).
  onboarded: { type: Boolean, default: false },
  verifyToken: { type: String, default: '' },         // single-use email verification token
  verifyTokenExpires: { type: Date },
  // The $99 sign-up fee. We collect a card on file at onboarding but DO NOT store
  // the PAN/CVC (PCI) — only the brand + last4 + an on-file flag. signupFeePaid
  // stays false until a real charge clears (wire Stripe later).
  cardOnFile: { type: Boolean, default: false },
  cardBrand: { type: String, default: '' },
  cardLast4: { type: String, default: '' },
  signupFeePaid: { type: Boolean, default: false },
  // Admin-curated "default top 20" showcase. Featured athletes surface to every
  // agent/brand regardless of roster ownership.
  featured: { type: Boolean, default: false },

  // Athlete fields
  sport: { type: String, default: '' },
  school: { type: String, default: '' },
  position: { type: String, default: '' },
  graduationYear: { type: Number },
  proStatus: { type: String, enum: ['collegiate', 'professional', ''], default: '' },
  nflTeam: { type: String, default: '' },
  statsUrl: { type: String, default: '' },
  cfbPlayerId: { type: String, default: '' },
  jerseyNumber: { type: Number },
  heightDisplay: { type: String, default: '' },   // e.g. "6'3\""
  weightLbs: { type: Number, default: 0 },          // e.g. 245
  fortyTime: { type: Number, default: 0 },          // e.g. 4.52
  classYear: { type: String, default: '' },         // e.g. "Junior"
  highlightUrl: { type: String, default: '' },      // YouTube/Hudl link
  draftRound: { type: String, default: '' },        // e.g. "1st - 2nd"
  draftTrend: { type: String, enum: ['up','down','steady',''], default: 'steady' },
  interestedTeams: [{ type: String }],              // e.g. ["NY Giants","Dallas Cowboys"]
  socialHandles: [socialHandleSchema],
  mediaKitItems: [mediaKitItemSchema],              // athlete-curated media-kit files + links
  // Media-kit export entitlement. Free accounts get the share-card PNG; the high-end
  // PDF media kit is the paid upgrade. 'kit' = $99 (PDF), 'pack' = $299 (PDF + program
  // outreach). Granted manually via /api/owner/export-tier until Stripe webhooks land.
  exportTier: { type: String, enum: ['free', 'kit', 'pack'], default: 'free' },
  agentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, // agent who created/represents this athlete; null = not on any agent's list
  nilValue: { type: Number, default: 0 },
  totalEarnings: { type: Number, default: 0 },
  dealsCompleted: { type: Number, default: 0 },

  // Subscription tier — applies to ALL billable roles (brand / athlete / agent).
  // The set of valid keys depends on role (see server/lib/plans.js). Defaults to
  // the role's free tier. Set by a Stripe webhook on checkout, the dev self-serve
  // fallback, or a vendor grant via /api/owner/plan. Capabilities + limits per tier
  // gate features across the app.
  plan: { type: String, default: 'free' },
  planSince: { type: Date },
  stripeCustomerId: { type: String, default: '' },
  stripeSubscriptionId: { type: String, default: '' },
  // Stripe Connect payout account (athletes/agents receiving deal payouts). Onboarded
  // via /api/billing/connect; payoutsEnabled flips true once Stripe clears the account
  // (charges_enabled + payouts_enabled). See lib/payments.js.
  stripeAccountId: { type: String, default: '' },
  payoutsEnabled: { type: Boolean, default: false },

  // Brand fields
  company: { type: String, default: '' },
  industry: { type: String, default: '' },
  website: { type: String, default: '' },
  logo: { type: String, default: '' },

  // Agent fields
  agency: { type: String, default: '' },
  athletes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

  // Coach fields (NCAA recruiting). A coach belongs to a program and recruits
  // athletes through the calendar-gated funnel (see models/Recruit.js). Coaches
  // never represent athletes or take deal fees.
  program: { type: String, default: '' },                       // institution / school
  division: { type: String, enum: ['D1', 'D2', 'D3', 'NAIA', 'JUCO', ''], default: '' },
  sportCoached: { type: String, default: '' },
  coachTitle: { type: String, default: '' },                    // Head Coach, Recruiting Coordinator, ...
  recruitingPhilosophy: { type: String, default: '', maxlength: 1000 },
  positionNeeds: [{ type: String }],
  scholarshipStatus: { type: String, default: '' },
  contactPrefs: { type: String, default: '' },
  introVideoUrl: { type: String, default: '' },
  coachRecord: { type: String, default: '' },                   // e.g. "84-21, 7 seasons"
  complianceOfficerEmail: { type: String, default: '', lowercase: true, trim: true },
  verifiedProgram: { type: Boolean, default: false },           // verified staff/program (self-serve .edu or admin)
  institutionalEmail: { type: String, default: '', lowercase: true, trim: true }, // school-domain email used to verify
  programVerifyToken: { type: String, default: '' },            // single-use self-serve verification token
  headCoachId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, // multi-seat owner
  // Per-field provenance for the profile: 'input' (coach-entered, authoritative)
  // vs a source name ('cfbd','staff','youtube'). Scraped fields stay unverified
  // until the coach confirms them. Stored as a plain object map.
  profileSources: { type: mongoose.Schema.Types.Mixed, default: {} },

  // Athlete recruiting-eligibility / minor protection (NCAA + youth-privacy). Used
  // to gate coach messaging: a minor recruit cannot be messaged until a guardian
  // consents. dateOfBirth is optional; isMinor can also be derived from gradYear.
  dateOfBirth: { type: Date },
  isHighSchool: { type: Boolean, default: false },

  // ── Athlete affiliate / referral program ────────────────────────────────────
  // Athletes earn referral CREDITS when someone they refer converts to a PAID plan
  // (or pays the sign-up fee). Credits redeem for free paid months (auto-applied via
  // planCompUntil). Rule of thumb: 2 referred athletes = 1 free month (athlete=1
  // credit, coach=2). See server/lib/affiliate.js + routes/affiliate.js.
  referralCode: { type: String, default: '', index: true, sparse: true },        // this user's own share code
  referredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, // who referred this user
  referralQualified: { type: Boolean, default: false },                          // this user already paid out their referrer (once)
  affiliateCredits: { type: Number, default: 0 },                                // spendable referral credits
  affiliateCreditsEarned: { type: Number, default: 0 },                          // lifetime credits earned
  qualifiedReferralCount: { type: Number, default: 0 },                          // # of referrals that converted to paid
  // Free-paid-months comp. While planCompUntil is in the future the user holds a
  // paid plan for free; planComped marks it so auth can auto-revert on expiry.
  planComped: { type: Boolean, default: false },
  planCompUntil: { type: Date },

  // Athlete bookmarks — opportunities saved from Discover
  savedDeals: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Deal' }],

  createdAt: { type: Date, default: Date.now }
});

userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

userSchema.methods.comparePassword = function (plain) {
  return bcrypt.compare(plain, this.password);
};

export default mongoose.model('User', userSchema);
