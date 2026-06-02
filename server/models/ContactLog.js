import mongoose from 'mongoose';

// Immutable, append-only audit trail of every coach↔recruit interaction. This is
// the "transparent" half of the compliance promise: the athlete (and their
// guardian), the coach, and the compliance officer/admin can all see exactly who
// contacted whom, when, on what channel, and which NCAA recruiting period was in
// effect at that moment. Records are never edited or deleted in normal operation.

export const CONTACT_KINDS = ['message', 'call', 'visit_scheduled', 'offer', 'consent', 'invite', 'note', 'blocked_attempt'];

const contactLogSchema = new mongoose.Schema({
  recruit: { type: mongoose.Schema.Types.ObjectId, ref: 'Recruit', required: true, index: true },
  coach: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  athlete: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },

  kind: { type: String, enum: CONTACT_KINDS, required: true },
  initiatedBy: { type: String, enum: ['coach', 'athlete', 'guardian', 'system'], default: 'coach' },
  channel: { type: String, default: 'in_app' },                 // in_app | email | phone | visit
  body: { type: String, default: '' },

  // Compliance snapshot at the time of the action — frozen, never recomputed.
  periodType: { type: String, default: '' },                    // contact|evaluation|quiet|dead|none|exempt
  allowed: { type: Boolean, default: true },                    // false on a blocked attempt
  blockReason: { type: String, default: '' },

  createdAt: { type: Date, default: Date.now }
});

export default mongoose.model('ContactLog', contactLogSchema);
