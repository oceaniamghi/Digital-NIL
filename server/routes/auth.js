import express from 'express';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import Activity from '../models/Activity.js';
import Deal from '../models/Deal.js';
import Lead from '../models/Lead.js';
import CrmEvent from '../models/CrmEvent.js';
import { requireAuth } from '../middleware/auth.js';
import { findYouTubeReel } from '../lib/youtube.js';
import { getLicenseState } from '../lib/license.js';

const router = express.Router();

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

// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { email, password, name, role, sport, school, company, industry, agency } = req.body;
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, password, and name are required' });
    }
    const existing = await User.findOne({ email });
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    // Seat metering: brands/sponsors are external and uncapped; staff logins are.
    const finalRole = role || 'athlete';
    if (finalRole !== 'brand') {
      const { seatLimit } = await getLicenseState();
      const seatsUsed = await seatUsage();
      if (seatsUsed >= seatLimit) {
        return res.status(402).json({ error: 'Seat limit reached for this workspace. Contact your administrator to add seats.' });
      }
    }

    const user = await User.create({
      email, password, name, role: finalRole,
      sport, school, company, industry, agency
    });

    const token = signToken(user._id);
    const { password: _, ...userObj } = user.toObject();
    res.status(201).json({ token, user: userObj });
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
    const { password: _, ...userObj } = user.toObject();
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
      'socialHandles', 'company', 'industry', 'website', 'logo', 'agency'];
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
    const { sport, minFollowers, search } = req.query;
    const query = { role: 'athlete' };

    // Role scoping
    if (req.user.role === 'agent') {
      // Agents (the roster admins) see only the athletes on their own roster
      query.agentId = req.user._id;
    } else {
      // Brands AND athletes are search/browse-only: they see only athletes that an
      // agent has put on a list (the curated marketplace). Athletes share brand perms.
      query.agentId = { $ne: null };
    }

    if (sport) query.sport = { $regex: sport, $options: 'i' };
    if (search) query.name = { $regex: search, $options: 'i' };

    let athletes = await User.find(query).select('-password').limit(50);

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
      const base = `${slug}@roster.aic`;
      finalEmail = base;
      let n = 1;
      while (await User.findOne({ email: finalEmail })) {
        n += 1;
        finalEmail = `${slug}.${n}@roster.aic`;
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
