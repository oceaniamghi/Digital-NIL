import mongoose from 'mongoose';

// A coach's recruiting-funnel record for a single prospective athlete. Modeled on
// the agent CRM Lead (computed score + pipeline stage) but coach-scoped and bound
// to NCAA compliance: consent + the recruiting calendar gate every coach-initiated
// contact. There are NO monetary/representation fields — coaches recruit only.

export const RECRUIT_STAGES = ['prospect', 'contacted', 'evaluating', 'visit_scheduled', 'offer_extended', 'committed', 'signed', 'closed'];
export const RECRUIT_RATINGS = ['priority', 'target', 'watch'];

// none      → no consent yet (off-platform prospect, tracking only)
// invited   → invite sent, awaiting registration/consent
// athlete   → an 18+ athlete opted in (or initiated contact themselves)
// guardian  → a minor's guardian consented (required before messaging a minor)
// revoked   → consent withdrawn; messaging is blocked again
export const CONSENT_STATES = ['none', 'invited', 'athlete', 'guardian', 'revoked'];

// Simple recruiting fit score (0–100): rating sets the floor, completeness adds.
export function computeRecruitScore(r = {}) {
  let s = { priority: 60, target: 40, watch: 20 }[r.rating] ?? 40;
  if (r.athlete) s += 15;                 // linked, real athlete
  if (r.position) s += 5;
  if (r.gradYear) s += 5;
  if (r.consentStatus === 'athlete' || r.consentStatus === 'guardian') s += 15;
  return Math.min(100, s);
}

const recruitSchema = new mongoose.Schema({
  coach: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

  // The prospect. `athlete` links to a registered User once they exist; off-platform
  // prospects keep athlete=null and carry name/email/phone until they register.
  athlete: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  name: { type: String, required: true, trim: true },
  email: { type: String, default: '', lowercase: true, trim: true },
  phone: { type: String, default: '' },

  // Recruiting attributes — sport/division drive which calendar period applies.
  sport: { type: String, default: '' },
  division: { type: String, enum: ['D1', 'D2', 'D3', 'NAIA', 'JUCO', ''], default: '' },
  position: { type: String, default: '' },
  school: { type: String, default: '' },
  gradYear: { type: Number },
  notes: { type: String, default: '' },
  tags: [{ type: String }],

  stage: { type: String, enum: RECRUIT_STAGES, default: 'prospect' },
  rating: { type: String, enum: RECRUIT_RATINGS, default: 'target' },
  score: { type: Number, default: 40 },

  // Who started the relationship. Athlete-initiated interest is calendar-EXEMPT and
  // implies consent; coach-initiated contact is calendar-gated.
  initiatedBy: { type: String, enum: ['coach', 'athlete'], default: 'coach' },
  offPlatform: { type: Boolean, default: false },

  // Compliance state.
  isMinor: { type: Boolean, default: false },
  consentStatus: { type: String, enum: CONSENT_STATES, default: 'none' },
  athleteConsentAt: { type: Date },
  guardianName: { type: String, default: '' },
  guardianEmail: { type: String, default: '', lowercase: true, trim: true },
  guardianConsentAt: { type: Date },
  inviteToken: { type: String, default: '' },   // for off-platform invite-to-consent

  lastContactedAt: { type: Date },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, { });

// One funnel record per coach per athlete (when linked).
recruitSchema.index({ coach: 1, athlete: 1 });

recruitSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  this.score = computeRecruitScore(this);
  next();
});

// Messaging is allowed only when consent is in place. Minors REQUIRE guardian
// consent; adults can be messaged on athlete consent. Revoked/none/invited block.
recruitSchema.methods.consentAllowsMessaging = function () {
  if (this.consentStatus === 'revoked' || this.consentStatus === 'none' || this.consentStatus === 'invited') return false;
  if (this.isMinor) return this.consentStatus === 'guardian';
  return this.consentStatus === 'athlete' || this.consentStatus === 'guardian';
};

export default mongoose.model('Recruit', recruitSchema);
