import express from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import Activity from '../models/Activity.js';
import Deal from '../models/Deal.js';
import Lead from '../models/Lead.js';
import CrmEvent from '../models/CrmEvent.js';
import Invite from '../models/Invite.js';
import { requireAuth, upgradeRequired } from '../middleware/auth.js';
import { planLimit, minPlanForLimit } from '../lib/plans.js';
import { findYouTubeReel } from '../lib/youtube.js';
import { findEspnHeadshotId } from './cfbd.js';
import { getLicenseState } from '../lib/license.js';
import { sendEmail } from '../lib/resend.js';

const router = express.Router();

// Email delivery is considered "live" only when Resend is configured. When it
// isn't, verification emails are logged (not sent), so we expose a no-email
// path on the verify screen instead of trapping the user forever.
const emailConfigured = () => !!process.env.RESEND_API_KEY;

// Best-effort verification email. Builds the link from an explicit APP/BASE_URL
// or falls back to the request's own origin so it works on any deployment.
const sendVerifyEmail = async (req, user) => {
  const base = (process.env.APP_URL || process.env.BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  const link = `${base}/verify/${user.verifyToken}`;
  const { status } = await sendEmail({
    to: user.email,
    subject: 'Verify your Digital NIL email',
    html: `<div style="font-family:system-ui,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px">
      <h2 style="margin:0 0 8px">Confirm your email</h2>
      <p style="color:#555;font-size:14px;line-height:1.6">Hi ${user.name || 'there'}, welcome to Digital NIL. Tap the button below to verify your email and finish setting up your account.</p>
      <p style="margin:24px 0"><a href="${link}" style="background:#1E1E1E;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;font-size:14px">Verify email →</a></p>
      <p style="color:#999;font-size:12px">Or paste this link into your browser:<br>${link}</p>
    </div>`
  });
  return status === 'sent';
};

// Billable seats = real, login-capable accounts. Agent-managed roster athletes
// and external brand/sponsor accounts don't consume a seat.
const seatUsage = () => User.countDocuments({ managed: { $ne: true }, role: { $ne: 'brand' } });

// Lightweight in-memory rate limit for the public interest endpoint (per IP).
const interestHits = new Map();
const rateLimited = (ip, max = 5, windowMs = 60000) => {
  const now = Date.now();
  const arr = (interestHits.get(ip) || []).filter(t => now - t < windowMs);
  arr.push(now);
  interestHits.set(ip, arr);
  return arr.length > max;
};

const signToken = (userId) =>
  jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '30d' });

// Universal agent invite code: a single shared code (override with AGENT_INVITE_CODE)
// that lets a teammate self-register as an agent without a per-email invite. Unlike
// Invite tokens it's reusable by design — rotate it via the env var if it leaks.
// Agents who join this way are NOT pre-verified and land on the Free plan.
const AGENT_INVITE_CODE = (process.env.AGENT_INVITE_CODE || 'DNIL-AGENTS-2026').trim();
const agentCodeMatches = (code) => {
  const a = Buffer.from(String(code || '').trim());
  const b = Buffer.from(AGENT_INVITE_CODE);
  return b.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
};

// GET /api/auth/invite/:token — PUBLIC. Validate an invite so the register screen
// can pre-fill role/agency/email and show who it's for before the user signs up.
router.get('/invite/:token', async (req, res) => {
  try {
    const inv = await Invite.findOne({ token: req.params.token });
    if (!inv || !inv.isUsable()) {
      return res.status(400).json({ valid: false, error: 'This invite is invalid or has expired.' });
    }
    res.json({ valid: true, email: inv.email, role: inv.role, agency: inv.agency });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { email, password, name, role, sport, school, company, industry, agency, inviteToken, inviteCode } = req.body;
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, password, and name are required' });
    }
    const normEmail = String(email).toLowerCase().trim();
    const existing = await User.findOne({ email: normEmail });
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    // Resolve the role. Self-service signup is limited to marketplace roles
    // (athlete/brand). Privileged roles (agent/admin) require either a per-email
    // invite token OR the shared universal agent code — this closes the
    // role-injection hole: a client can no longer pick role:'agent'/'admin' just by
    // putting it in the body.
    let finalRole;
    let finalAgency = agency;
    let presetPlan = null;
    let invite = null;
    if (inviteToken) {
      invite = await Invite.findOne({ token: inviteToken });
      if (!invite || !invite.isUsable()) {
        return res.status(400).json({ error: 'This invite is invalid or has expired.' });
      }
      if (invite.email && invite.email !== normEmail) {
        return res.status(400).json({ error: 'This invite was issued for a different email address.' });
      }
      finalRole = invite.role;
      finalAgency = invite.agency || agency;
      presetPlan = invite.plan || null;
    } else if (inviteCode) {
      // Universal agent code: reusable, agent-only. Reject a wrong code outright so
      // the user gets a clear error instead of silently becoming an athlete.
      if (!agentCodeMatches(inviteCode)) {
        return res.status(400).json({ error: 'That invite code is not valid.' });
      }
      finalRole = 'agent';
      finalAgency = agency || '';
    } else {
      // No invite: only the two self-service roles are allowed. Anything else
      // (agent/admin attempts) silently falls back to athlete.
      finalRole = role === 'brand' ? 'brand' : 'athlete';
    }

    // Seat metering: brands/sponsors are external and uncapped; staff logins are.
    if (finalRole !== 'brand') {
      const { seatLimit } = await getLicenseState();
      const seatsUsed = await seatUsage();
      if (seatsUsed >= seatLimit) {
        return res.status(402).json({ error: 'Seat limit reached for this workspace. Contact your administrator to add seats.' });
      }
    }

    // An invite delivered to a specific address proves email ownership, so an
    // email-locked invite skips the verification step.
    const preVerified = !!(invite && invite.email && invite.email === normEmail);

    const verifyToken = preVerified ? '' : crypto.randomBytes(24).toString('hex');
    const user = await User.create({
      email: normEmail, password, name, role: finalRole,
      sport, school, company, industry, agency: finalAgency,
      ...(presetPlan ? { plan: presetPlan, planSince: new Date() } : {}),
      verified: preVerified, onboarded: false,
      verifyToken,
      ...(preVerified ? {} : { verifyTokenExpires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) })
    });

    // Consume the invite so it can't be reused.
    if (invite) {
      invite.usedAt = new Date();
      invite.usedBy = user._id;
      await invite.save();
    }

    // Fire the verification email (skipped when pre-verified; no-op/logged when
    // Resend isn't configured).
    const verifySent = preVerified ? false : await sendVerifyEmail(req, user).catch(() => false);

    const token = signToken(user._id);
    const { password: _, verifyToken: __, ...userObj } = user.toObject();
    res.status(201).json({ token, user: userObj, verifySent, emailConfigured: emailConfigured() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/verify/:token — PUBLIC. Consumes a verification token and marks
// the account verified. Safe to hit from any device (e.g. the email link).
router.get('/verify/:token', async (req, res) => {
  try {
    const user = await User.findOne({
      verifyToken: req.params.token,
      verifyTokenExpires: { $gt: new Date() }
    });
    if (!user) return res.status(400).json({ error: 'This verification link is invalid or has expired.' });
    user.verified = true;
    user.verifyToken = '';
    user.verifyTokenExpires = undefined;
    await user.save();
    res.json({ ok: true, verified: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/resend-verification — re-issue + resend the email for the
// signed-in (still unverified) account.
router.post('/resend-verification', requireAuth, async (req, res) => {
  try {
    if (req.user.verified) return res.json({ ok: true, alreadyVerified: true });
    const user = await User.findById(req.user._id);
    user.verifyToken = crypto.randomBytes(24).toString('hex');
    user.verifyTokenExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await user.save();
    const verifySent = await sendVerifyEmail(req, user).catch(() => false);
    res.json({ ok: true, verifySent, emailConfigured: emailConfigured() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/dev-verify — escape hatch ONLY when email delivery isn't
// configured on this deployment, so demo/self-hosted installs aren't trapped on
// the verify screen. Refuses once Resend is live (then the email is the path).
router.post('/dev-verify', requireAuth, async (req, res) => {
  try {
    if (emailConfigured()) {
      return res.status(403).json({ error: 'Email delivery is enabled — please use the link we emailed you.' });
    }
    const user = await User.findByIdAndUpdate(
      req.user._id,
      { verified: true, verifyToken: '', $unset: { verifyTokenExpires: 1 } },
      { new: true }
    ).select('-password -verifyToken');
    res.json({ ok: true, user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Detect the card brand from the leading digits (display only — we never store
// the full number). Mirrors the major IIN ranges.
const cardBrandOf = (digits) => {
  if (/^4/.test(digits)) return 'Visa';
  if (/^(5[1-5]|2[2-7])/.test(digits)) return 'Mastercard';
  if (/^3[47]/.test(digits)) return 'Amex';
  if (/^(6011|65|64[4-9])/.test(digits)) return 'Discover';
  return 'Card';
};

// POST /api/auth/onboarding — collect phone + card on file before the dashboard.
// We store ONLY phone, card brand + last4, and an on-file flag. The PAN/CVC are
// discarded immediately. signupFeePaid stays false until a real $99 charge clears.
router.post('/onboarding', requireAuth, async (req, res) => {
  try {
    const { phone, card } = req.body || {};
    const updates = { onboarded: true };
    if (phone) updates.phone = String(phone).trim().slice(0, 32);
    if (card && card.number) {
      const digits = String(card.number).replace(/\D/g, '');
      if (digits.length < 12 || digits.length > 19) {
        return res.status(400).json({ error: 'Please enter a valid card number.' });
      }
      updates.cardOnFile = true;
      updates.cardBrand = cardBrandOf(digits);
      updates.cardLast4 = digits.slice(-4);
    }
    const user = await User.findByIdAndUpdate(req.user._id, updates, { new: true }).select('-password -verifyToken');
    res.json({ ok: true, user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/onboarding/skip — let the user into the app without a card. The
// $99 sign-up fee is owed and can be collected later (signupFeePaid stays false).
router.post('/onboarding/skip', requireAuth, async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(
      req.user._id,
      { onboarded: true, cardOnFile: false },
      { new: true }
    ).select('-password -verifyToken');
    res.json({ ok: true, user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const user = await User.findOne({ email });
    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    user.lastLoginAt = new Date();
    await user.save();

    const token = signToken(user._id);
    const { password: _, verifyToken: __, ...userObj } = user.toObject();
    res.json({ token, user: userObj });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// PUT /api/auth/profile
router.put('/profile', requireAuth, async (req, res) => {
  try {
    const allowed = ['name', 'bio', 'avatar', 'sport', 'school', 'position', 'graduationYear',
      'proStatus', 'nflTeam', 'statsUrl', 'cfbPlayerId',
      'jerseyNumber', 'heightDisplay', 'weightLbs', 'fortyTime', 'classYear',
      'highlightUrl', 'draftRound', 'draftTrend', 'interestedTeams',
      'socialHandles', 'mediaKitItems', 'company', 'industry', 'website', 'logo', 'agency'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    // Athletes who save without a highlight reel get a default pulled from YouTube.
    if (req.user.role === 'athlete') {
      const willHave = updates.highlightUrl !== undefined ? updates.highlightUrl : req.user.highlightUrl;
      if (!willHave) {
        updates.highlightUrl = await findYouTubeReel({
          name: updates.name || req.user.name,
          school: updates.school || req.user.school,
          position: updates.position || req.user.position,
          sport: updates.sport || req.user.sport
        });
      }
    }

    const user = await User.findByIdAndUpdate(req.user._id, updates, { new: true }).select('-password');
    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/auth/social
router.put('/social', requireAuth, async (req, res) => {
  try {
    const { platform, handle, followers } = req.body;
    const user = await User.findById(req.user._id);
    const idx = user.socialHandles.findIndex(s => s.platform === platform);
    if (idx >= 0) {
      user.socialHandles[idx] = { platform, handle, followers: followers || 0, connected: true };
    } else {
      user.socialHandles.push({ platform, handle, followers: followers || 0, connected: true });
    }
    await user.save();

    await Activity.create({
      user: user._id,
      type: 'social_connected',
      title: 'Social account connected',
      message: `Connected ${platform} account @${handle}`
    });

    const { password: _, ...userObj } = user.toObject();
    res.json({ user: userObj });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/athletes/:id — public athlete profile + media-kit extras (sharing)
router.get('/athletes/:id', async (req, res) => {
  try {
    const athlete = await User.findById(req.params.id)
      .select('-password -email')
      .where('role').equals('athlete');
    if (!athlete) return res.status(404).json({ error: 'Athlete not found' });

    // Deal-derived "proof" for brands: who they've worked with + reach delivered.
    // Best-effort — never block the profile if this fails.
    const mediaKit = { brands: [], delivered: { impressions: 0, engagements: 0, reach: 0 } };
    try {
      const deals = await Deal.find({ athlete: athlete._id, status: { $in: ['active', 'completed'] } })
        .populate('brand', 'company name logo')
        .select('brand metrics status');
      const seen = new Set();
      for (const d of deals) {
        const b = d.brand;
        if (b && !seen.has(String(b._id))) {
          seen.add(String(b._id));
          mediaKit.brands.push({ company: b.company || b.name, logo: b.logo || '' });
        }
        if (d.status === 'completed' && d.metrics) {
          mediaKit.delivered.impressions += d.metrics.impressions || 0;
          mediaKit.delivered.engagements += d.metrics.engagements || 0;
          mediaKit.delivered.reach += d.metrics.reach || 0;
        }
      }
      mediaKit.brands = mediaKit.brands.slice(0, 8);
    } catch { /* keep empty extras */ }

    res.json({ athlete, mediaKit });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/athletes/:id/interest — PUBLIC inbound interest from an
// athlete's shareable page. Routes a Lead to the athlete's agent and notifies
// the athlete. Honeypot + rate limit guard against bots/spam.
router.post('/athletes/:id/interest', async (req, res) => {
  try {
    const { fromName, company, email, message, _hp } = req.body;
    // Honeypot: bots fill the hidden field — pretend success, do nothing.
    if (_hp) return res.json({ ok: true });
    if (!fromName || !email) return res.status(400).json({ error: 'Name and email are required' });

    const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
    if (rateLimited(ip)) return res.status(429).json({ error: 'Too many requests — try again shortly' });

    const athlete = await User.findById(req.params.id).where('role').equals('athlete').select('name agentId');
    if (!athlete) return res.status(404).json({ error: 'Athlete not found' });

    const note = `Inbound interest in ${athlete.name}${company ? ` from ${company}` : ''}${message ? `: ${message}` : ''}`;

    // Route to the athlete's agent as a CRM lead (dedup by owner+email).
    if (athlete.agentId) {
      const existing = await Lead.findOne({
        owner: athlete.agentId, email: String(email).toLowerCase(),
        status: { $ne: 'converted' }
      });
      if (existing) {
        await CrmEvent.create({ owner: athlete.agentId, kind: 'note', body: note });
      } else {
        await Lead.create({
          name: fromName, company: company || '', email, source: 'inbound',
          rating: 'warm', status: 'new', notes: note, owner: athlete.agentId
        });
      }
      await Activity.create({
        user: athlete.agentId, type: 'deal_offer', title: 'New inbound interest',
        message: `${fromName}${company ? ` (${company})` : ''} is interested in ${athlete.name}`
      });
    }

    // Notify the athlete either way.
    await Activity.create({
      user: athlete._id, type: 'deal_offer', title: 'A brand is interested',
      message: `${fromName}${company ? ` from ${company}` : ''} reached out via your profile`
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/athletes — role-scoped athlete directory
router.get('/athletes', requireAuth, async (req, res) => {
  try {
    const { sport, minFollowers, search, featured } = req.query;
    const query = { role: 'athlete' };
    const wantFeatured = featured === '1' || featured === 'true';

    // Role scoping
    if (wantFeatured) {
      // The admin-curated "default top 20" showcase — visible to every role.
      query.featured = true;
    } else if (req.user.role === 'admin') {
      // Admins see the whole athlete pool.
    } else if (req.user.role === 'agent') {
      // Agents (the roster admins) see their own roster PLUS the featured showcase,
      // so every agent loads with the default top athletes out of the box.
      query.$or = [{ agentId: req.user._id }, { featured: true }];
    } else {
      // Brands AND athletes are search/browse-only: they see athletes an agent has
      // listed OR the admin's featured showcase. Athletes share brand perms.
      query.$or = [{ agentId: { $ne: null } }, { featured: true }];
    }

    if (sport) query.sport = { $regex: sport, $options: 'i' };
    if (search) query.name = { $regex: search, $options: 'i' };

    const limit = wantFeatured ? 20 : 50;
    let athletes = await User.find(query).select('-password -verifyToken').limit(limit);

    if (minFollowers) {
      const min = parseInt(minFollowers);
      athletes = athletes.filter(a =>
        a.socialHandles.some(s => s.followers >= min)
      );
    }

    res.json({ athletes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/athletes — agent adds an athlete to their roster
router.post('/athletes', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'agent') {
      return res.status(403).json({ error: 'Only agents can add athletes to the roster' });
    }

    // Each agent tier caps roster size (Agency = unlimited). Count the agent's
    // current managed athletes against their plan limit.
    const rosterLimit = planLimit(req.user, 'roster');
    if (Number.isFinite(rosterLimit)) {
      const count = await User.countDocuments({ role: 'athlete', agentId: req.user._id });
      if (count >= rosterLimit) {
        const min = minPlanForLimit('agent', 'roster', rosterLimit + 1);
        return upgradeRequired(res, `Your plan allows ${rosterLimit} roster athletes. Upgrade${min ? ` to ${min.name}` : ''} to add more.`, min);
      }
    }

    const {
      name, email, school, position, jerseyNumber, heightDisplay, weightLbs,
      fortyTime, classYear, bio, avatar, highlightUrl, cfbPlayerId, draftRound, draftTrend, interestedTeams,
      socialHandles, nilValue, sport, graduationYear
    } = req.body;

    if (!name) return res.status(400).json({ error: 'Name is required' });

    // Resolve a unique email (generate one if none provided)
    let finalEmail = email;
    if (!finalEmail) {
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '');
      const base = `${slug}@roster.dnil`;
      finalEmail = base;
      let n = 1;
      while (await User.findOne({ email: finalEmail })) {
        n += 1;
        finalEmail = `${slug}.${n}@roster.dnil`;
      }
    }

    // Auto-find a default highlight reel on YouTube when none was provided.
    const finalHighlight = highlightUrl
      || await findYouTubeReel({ name, school, position, sport: sport || 'Football' });

    const created = await User.create({
      role: 'athlete',
      verified: true,
      managed: true,
      sport: sport || 'Football',
      agentId: req.user._id,
      password: Math.random().toString(36).slice(2) + Date.now(),
      email: finalEmail,
      name, school, position, jerseyNumber, heightDisplay, weightLbs,
      fortyTime, classYear, bio, avatar, highlightUrl: finalHighlight, cfbPlayerId, draftRound, draftTrend, interestedTeams,
      socialHandles, nilValue, graduationYear
    });

    // Keep the agent's roster array consistent
    await User.findByIdAndUpdate(req.user._id, { $addToSet: { athletes: created._id } });

    const athlete = await User.findById(created._id).select('-password');
    res.status(201).json({ athlete });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/athletes/backfill-highlights — find reels for the agent's roster.
// Default: fill only athletes missing a reel. With { force: true }: re-find every
// athlete and replace existing reels (used to refresh links blocked off-YouTube).
router.post('/athletes/backfill-highlights', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'agent') {
      return res.status(403).json({ error: 'Only agents can backfill highlight reels' });
    }
    const force = req.body.force === true;
    const query = { role: 'athlete', agentId: req.user._id };
    if (!force) {
      query.$or = [{ highlightUrl: '' }, { highlightUrl: null }, { highlightUrl: { $exists: false } }];
    }
    const roster = await User.find(query);
    let filled = 0;
    for (const a of roster) {
      const url = await findYouTubeReel({ name: a.name, school: a.school, position: a.position, sport: a.sport });
      if (url && url !== a.highlightUrl) {
        a.highlightUrl = url;
        await a.save();
        filled += 1;
      }
    }
    res.json({ ok: true, scanned: roster.length, filled, force });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/athletes/backfill-headshots — resolve ESPN headshots for the
// agent's roster. Default: fill only athletes with no avatar. With { force: true }:
// re-resolve every athlete's CFBD/ESPN id and refresh the avatar URL.
router.post('/athletes/backfill-headshots', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'agent') {
      return res.status(403).json({ error: 'Only agents can backfill headshots' });
    }
    const force = req.body.force === true;
    const query = { role: 'athlete', agentId: req.user._id };
    if (!force) {
      query.$or = [{ avatar: '' }, { avatar: null }, { avatar: { $exists: false } }];
    }
    const roster = await User.find(query);
    let filled = 0;
    for (const a of roster) {
      // Reuse a stored CFBD/ESPN id when present; otherwise resolve one by name.
      let id = a.cfbPlayerId;
      if (!id || force) id = (await findEspnHeadshotId(a.name, a.school)) || a.cfbPlayerId;
      if (!id) continue;
      const url = `https://a.espncdn.com/i/headshots/college-football/players/full/${id}.png`;
      if (id !== a.cfbPlayerId || url !== a.avatar) {
        a.cfbPlayerId = id;
        a.avatar = url;
        await a.save();
        filled += 1;
      }
    }
    res.json({ ok: true, scanned: roster.length, filled, force });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/auth/athletes/:id — agent removes an athlete from their roster
router.delete('/athletes/:id', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'agent') {
      return res.status(403).json({ error: 'Only agents can remove athletes from the roster' });
    }

    const athlete = await User.findById(req.params.id);
    if (!athlete) return res.status(404).json({ error: 'Athlete not found' });

    if (!athlete.agentId || String(athlete.agentId) !== String(req.user._id)) {
      return res.status(403).json({ error: 'You can only remove athletes from your own roster' });
    }

    await User.findByIdAndDelete(req.params.id);
    await User.findByIdAndUpdate(req.user._id, { $pull: { athletes: athlete._id } });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
