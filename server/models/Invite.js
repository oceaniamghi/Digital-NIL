import mongoose from 'mongoose';
import crypto from 'crypto';

// Single-use invite token for PRIVILEGED roles (agent/admin). Self-service signup
// is limited to marketplace roles (athlete/brand); becoming an agent or admin
// requires consuming one of these — this is what closes the role-injection hole on
// /api/auth/register. An invite may be email-locked (only that address can redeem
// it) or open (anyone with the link, until it expires or is used).
const inviteSchema = new mongoose.Schema({
  token: { type: String, required: true, unique: true, index: true },
  email: { type: String, default: '', lowercase: true, trim: true }, // '' = not email-locked
  role: { type: String, enum: ['agent', 'admin'], default: 'agent' },
  agency: { type: String, default: '' },        // stamped onto the new agent
  plan: { type: String, default: '' },          // optional preset subscription tier
  invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  expiresAt: { type: Date, required: true },
  usedAt: { type: Date, default: null },
  usedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  createdAt: { type: Date, default: Date.now }
});

// Mint a usable invite with a strong random token and a default 7-day expiry.
inviteSchema.statics.mint = function (fields = {}) {
  return this.create({
    token: crypto.randomBytes(24).toString('hex'),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    ...fields
  });
};

// Usable = never redeemed and not past expiry.
inviteSchema.methods.isUsable = function () {
  return !this.usedAt && this.expiresAt > new Date();
};

export default mongoose.model('Invite', inviteSchema);
