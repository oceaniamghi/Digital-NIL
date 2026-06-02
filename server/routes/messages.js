import express from 'express';
import mongoose from 'mongoose';
import Message, { threadId } from '../models/Message.js';
import Deal from '../models/Deal.js';
import Activity from '../models/Activity.js';
import User from '../models/User.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();
const oid = (id) => mongoose.Types.ObjectId.isValid(id);

// Messaging is RELATIONSHIP-GATED so the marketplace can't be spammed: you may DM
// someone you have a real connection with (a deal, an application, or an agent↔roster
// link). Coaches use the separate compliance-gated recruit channel, not this one.
async function relationshipExists(me, other) {
  if (me.role === 'admin' || other.role === 'admin') return true;

  const agent = me.role === 'agent' ? me : (other.role === 'agent' ? other : null);
  const athlete = me.role === 'athlete' ? me : (other.role === 'athlete' ? other : null);
  if (agent && athlete) {
    const full = await User.findById(agent._id).select('athletes');
    if ((full?.athletes || []).some(a => String(a) === String(athlete._id))) return true;
    if (String(athlete.agentId || '') === String(agent._id)) return true;
  }

  const brand = me.role === 'brand' ? me : (other.role === 'brand' ? other : null);
  if (brand && athlete) {
    const deal = await Deal.findOne({
      brand: brand._id,
      $or: [{ athlete: athlete._id }, { 'applications.athlete': athlete._id }]
    }).select('_id');
    if (deal) return true;
  }

  if (agent && brand) {
    const full = await User.findById(agent._id).select('athletes');
    const roster = (full?.athletes || []);
    if (roster.length) {
      const deal = await Deal.findOne({ brand: brand._id, athlete: { $in: roster } }).select('_id');
      if (deal) return true;
    }
  }
  return false;
}

// Brands may not cold-DM a minor athlete; only the athlete's own agent (or admin) can.
function blockedForMinor(me, other) {
  if (other.role === 'athlete' && other.isMinor && me.role === 'brand') {
    return 'For their protection, minor athletes can only be contacted through their agent.';
  }
  return null;
}

// Resolve the "other" participant id from a thread key (`${a}_${b}`) relative to me.
const otherFromThread = (thread, meId) => String(thread || '').split('_').find(p => p && p !== String(meId));

// ── GET / — conversations in the exact shape the Inbox UI renders. Each thread
// carries the recent messages inline (from:'me'|'them') so the chat pane is populated
// without a second fetch. This is what client Messages() calls as GET /messages.
router.get('/', requireAuth, async (req, res) => {
  try {
    const meId = String(req.user._id);
    const msgs = await Message.find({ participants: req.user._id })
      .sort({ createdAt: 1 })
      .populate('from', 'name avatar role company agency')
      .populate('to', 'name avatar role company agency')
      .limit(1000)
      .lean();

    const byThread = new Map();
    for (const m of msgs) {
      const mine = String(m.from._id) === meId;
      const other = mine ? m.to : m.from;
      if (!byThread.has(m.thread)) {
        byThread.set(m.thread, {
          _id: m.thread, kind: 'direct',
          participant: {
            id: other._id, name: other.company || other.name || 'User',
            avatar: other.avatar || other.logo, tag: String(other.role || '').toUpperCase()
          },
          subject: '', preview: '', updatedAt: m.createdAt, unread: false, messages: []
        });
      }
      const t = byThread.get(m.thread);
      t.messages.push({ from: mine ? 'me' : 'them', text: m.body, at: m.createdAt });
      t.preview = m.body;
      t.updatedAt = m.createdAt;
      if (!mine && !m.read) t.unread = true;
    }
    const threads = [...byThread.values()].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    res.json({ threads });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST / — send a message. Accepts the UI's { threadId, text } OR { to, body }.
router.post('/', requireAuth, async (req, res) => {
  try {
    const text = String(req.body?.text || req.body?.body || '').trim();
    if (!text) return res.status(400).json({ error: 'Message body required' });
    let toId = req.body?.to;
    if (!toId && req.body?.threadId) toId = otherFromThread(req.body.threadId, req.user._id);
    if (!oid(toId)) return res.status(400).json({ error: 'No valid recipient' });
    if (String(toId) === String(req.user._id)) return res.status(400).json({ error: 'You cannot message yourself' });

    const other = await User.findById(toId).select('name role isMinor agentId');
    if (!other) return res.status(404).json({ error: 'Recipient not found' });

    const minorBlock = blockedForMinor(req.user, other);
    if (minorBlock) return res.status(403).json({ error: minorBlock });
    if (!(await relationshipExists(req.user, other))) {
      return res.status(403).json({ error: 'You can only message someone you have a deal or roster relationship with.' });
    }

    const msg = await Message.create({
      thread: threadId(req.user._id, other._id),
      participants: [req.user._id, other._id],
      from: req.user._id, to: other._id, body: text.slice(0, 4000),
      relatedDeal: oid(req.body?.dealId) ? req.body.dealId : undefined
    });
    await Activity.create({
      user: other._id, type: 'deal_offer',
      title: `New message from ${req.user.name}`, message: text.slice(0, 200)
    }).catch(() => {});

    res.status(201).json({ message: { _id: msg._id, from: 'me', text: msg.body, at: msg.createdAt } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /unread-count — badge count across all threads.
router.get('/unread-count', requireAuth, async (req, res) => {
  try {
    const count = await Message.countDocuments({ to: req.user._id, read: false });
    res.json({ count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /thread/:userId — the conversation with one user; marks their msgs read. (Named
// /thread/* so it never collides with the root or unread-count routes.)
router.get('/thread/:userId', requireAuth, async (req, res) => {
  try {
    if (!oid(req.params.userId)) return res.status(400).json({ error: 'Invalid user' });
    const thread = threadId(req.user._id, req.params.userId);
    const messages = await Message.find({ thread }).sort({ createdAt: 1 }).populate('from', 'name avatar role').limit(500);
    await Message.updateMany({ thread, to: req.user._id, read: false }, { read: true });
    const other = await User.findById(req.params.userId).select('name avatar role company agency sport school');
    res.json({ messages, with: other });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
