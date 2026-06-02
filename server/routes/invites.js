import express from 'express';
import Invite from '../models/Invite.js';
import User from '../models/User.js';
import { requireAuth } from '../middleware/auth.js';
import { sendEmail } from '../lib/resend.js';

const router = express.Router();

// All invite management requires a login. Authorization is per-action below:
//   - admin: may invite an 'agent' OR another 'admin', into any agency
//   - agent: may invite an 'agent' into their OWN agency only (team teammates)
//   - everyone else: may not invite
router.use(requireAuth);

const canInvite = (user, role) => {
  if (user.role === 'admin') return role === 'agent' || role === 'admin';
  if (user.role === 'agent') return role === 'agent';
  return false;
};

const baseUrl = (req) =>
  (process.env.APP_URL || process.env.BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

const inviteLink = (req, token) => `${baseUrl(req)}/register?invite=${token}`;

// Strip the token-bearing fields the caller shouldn't need to re-derive.
const publicInvite = (req, inv) => ({
  token: inv.token,
  email: inv.email,
  role: inv.role,
  agency: inv.agency,
  plan: inv.plan,
  link: inviteLink(req, inv.token),
  expiresAt: inv.expiresAt,
  usedAt: inv.usedAt,
  createdAt: inv.createdAt
});

const sendInviteEmail = async (req, inv, fromName) => {
  if (!inv.email) return false; // open link — nothing to send to
  const link = inviteLink(req, inv.token);
  const roleLabel = inv.role === 'admin' ? 'an administrator' : 'an agent';
  const { status } = await sendEmail({
    to: inv.email,
    subject: `You've been invited to Digital NIL`,
    html: `<div style="font-family:system-ui,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px">
      <h2 style="margin:0 0 8px">You're invited</h2>
      <p style="color:#555;font-size:14px;line-height:1.6">${fromName || 'Your team'} invited you to join Digital NIL as ${roleLabel}${inv.agency ? ` at ${inv.agency}` : ''}. Tap below to create your account.</p>
      <p style="margin:24px 0"><a href="${link}" style="background:#1E1E1E;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;font-size:14px">Accept invite →</a></p>
      <p style="color:#999;font-size:12px">Or paste this link into your browser:<br>${link}</p>
      <p style="color:#999;font-size:12px">This invite expires on ${new Date(inv.expiresAt).toLocaleDateString()}.</p>
    </div>`
  });
  return status === 'sent';
};

// POST /api/invites — mint an invite. Body: { email?, role?, agency?, plan? }
router.post('/', async (req, res) => {
  try {
    const role = req.body.role || 'agent';
    if (!canInvite(req.user, role)) {
      return res.status(403).json({ error: 'You are not allowed to issue this kind of invite.' });
    }

    const email = req.body.email ? String(req.body.email).toLowerCase().trim() : '';
    if (email) {
      const existing = await User.findOne({ email });
      if (existing) return res.status(409).json({ error: 'That email already has an account.' });
    }

    // Agents are pinned to their own agency; admins may set any agency.
    const agency = req.user.role === 'agent' ? (req.user.agency || '') : (req.body.agency || '');
    const plan = req.body.plan ? String(req.body.plan).trim() : '';

    const invite = await Invite.mint({ email, role, agency, plan, invitedBy: req.user._id });
    const emailed = await sendInviteEmail(req, invite, req.user.name).catch(() => false);

    res.status(201).json({ ok: true, invite: publicInvite(req, invite), emailed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/invites — list invites. Admins see all; agents see only their own.
router.get('/', async (req, res) => {
  try {
    const query = req.user.role === 'admin' ? {} : { invitedBy: req.user._id };
    const invites = await Invite.find(query).sort({ createdAt: -1 }).limit(200);
    res.json({ invites: invites.map(i => publicInvite(req, i)) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/invites/:token — revoke an unused invite. Admins revoke any; agents
// revoke only ones they issued.
router.delete('/:token', async (req, res) => {
  try {
    const inv = await Invite.findOne({ token: req.params.token });
    if (!inv) return res.status(404).json({ error: 'Invite not found' });
    if (req.user.role !== 'admin' && String(inv.invitedBy) !== String(req.user._id)) {
      return res.status(403).json({ error: 'You can only revoke invites you issued.' });
    }
    if (inv.usedAt) return res.status(400).json({ error: 'That invite has already been redeemed.' });
    await Invite.deleteOne({ _id: inv._id });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
