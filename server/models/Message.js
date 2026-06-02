import mongoose from 'mongoose';

// Direct messaging for the NIL side (brand ↔ athlete ↔ agent). The coach ↔ recruit
// channel is deliberately SEPARATE (models/ContactLog.js) because it carries NCAA
// calendar + guardian-consent gating; this model is the lighter deal-negotiation DM.
//
// A conversation is identified by `thread` — the two participant ids sorted and
// joined — so every message between the same pair lands in one stable thread without
// a separate Conversation document.

const messageSchema = new mongoose.Schema({
  thread: { type: String, required: true, index: true },          // `${minId}_${maxId}`
  participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  from: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  to: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  body: { type: String, required: true, maxlength: 4000 },
  read: { type: Boolean, default: false },
  relatedDeal: { type: mongoose.Schema.Types.ObjectId, ref: 'Deal' },
  createdAt: { type: Date, default: Date.now }
});

messageSchema.index({ thread: 1, createdAt: 1 });

// Deterministic thread id for a pair of user ids (order-independent).
export const threadId = (a, b) => [String(a), String(b)].sort().join('_');

export default mongoose.model('Message', messageSchema);
