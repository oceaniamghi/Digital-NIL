import express from 'express';
import mongoose from 'mongoose';
import User from '../models/User.js';
import Deal from '../models/Deal.js';
import { requireAuth, upgradeRequired } from '../middleware/auth.js';
import { planCan, minPlanForCap } from '../lib/plans.js';
import { findYouTubeReelIds } from '../lib/youtube.js';
import { computeFmv } from '../lib/valuation.js';

const router = express.Router();
const oid = (id) => mongoose.Types.ObjectId.isValid(id);

// Closed-deal comps for an athlete = the gross of every deal they've actually completed.
async function compsFor(athleteId) {
  const deals = await Deal.find({ athlete: athleteId, status: 'completed' }).select('compensation').lean();
  return deals.map(d => d.compensation?.amount || 0).filter(Boolean);
}

// Resolve + serialize an FMV estimate for an athlete user doc.
async function fmvForAthlete(athlete) {
  const comps = await compsFor(athlete._id);
  return computeFmv({
    socialHandles: athlete.socialHandles || [],
    sport: athlete.sport, proStatus: athlete.proStatus,
    draftTrend: athlete.draftTrend, comps
  });
}

// GET /api/socials/fmv — the logged-in athlete's own FMV (also persists nilValue).
router.get('/fmv', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'athlete') return res.status(400).json({ error: 'FMV applies to athletes.' });
    const fmv = await fmvForAthlete(req.user);
    if (fmv.annual && fmv.annual !== req.user.nilValue) {
      await User.findByIdAndUpdate(req.user._id, { nilValue: fmv.annual }).catch(() => {});
    }
    res.json({ fmv });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/socials/fmv/:athleteId — brand/agent/admin view of an athlete's FMV. Brands
// need the fmvAnalytics capability (Growth+); agents can value their roster; admins any.
router.get('/fmv/:athleteId', requireAuth, async (req, res) => {
  try {
    if (!oid(req.params.athleteId)) return res.status(400).json({ error: 'Invalid athlete' });
    const athlete = await User.findOne({ _id: req.params.athleteId, role: 'athlete' })
      .select('name socialHandles sport proStatus draftTrend nilValue agentId');
    if (!athlete) return res.status(404).json({ error: 'Athlete not found' });

    if (req.user.role === 'athlete' && String(req.user._id) !== String(athlete._id)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (req.user.role === 'brand' && !planCan(req.user, 'fmvAnalytics')) {
      return upgradeRequired(res, 'Fair-market-value analytics', minPlanForCap('brand', 'fmvAnalytics'));
    }
    const fmv = await fmvForAthlete(athlete);
    res.json({ fmv, athlete: { id: athlete._id, name: athlete.name } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// RapidAPI scraper providers. Hosts are overridable via env so you can swap to
// whichever RapidAPI product you've subscribed to without touching code — the
// follower count is extracted by deep-search, so response shape differences are
// tolerated. Subscribe to one product per platform on rapidapi.com and put the
// single shared key in RAPIDAPI_KEY.
const PROVIDERS = {
  instagram: {
    host: process.env.RAPIDAPI_INSTAGRAM_HOST || 'instagram-scraper-api2.p.rapidapi.com',
    path: h => `/v1/info?username_or_id_or_url=${encodeURIComponent(h)}`
  },
  tiktok: {
    host: process.env.RAPIDAPI_TIKTOK_HOST || 'tiktok-scraper7.p.rapidapi.com',
    path: h => `/user/info?unique_id=${encodeURIComponent(h)}`
  },
  twitter: {
    host: process.env.RAPIDAPI_TWITTER_HOST || 'twitter-api45.p.rapidapi.com',
    path: h => `/screenname.php?screenname=${encodeURIComponent(h)}`
  }
};

const FOLLOWER_KEY = /^(follower_count|followers_count|followerCount|sub_count|subscriberCount|edge_followed_by)$/i;

function toNumber(v) {
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v.replace(/[, ]/g, ''));
    if (isFinite(n) && v.trim() !== '') return n;
  }
  // Instagram web shape: edge_followed_by: { count: N }
  if (v && typeof v === 'object' && typeof v.count === 'number') return v.count;
  return null;
}

// Scraper response shapes vary by provider; walk the JSON for the first
// plausible follower-count field rather than hard-coding a path.
function findFollowers(node, depth = 0) {
  if (node == null || depth > 6) return null;
  if (Array.isArray(node)) {
    for (const v of node) {
      const r = findFollowers(v, depth + 1);
      if (r != null) return r;
    }
    return null;
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (FOLLOWER_KEY.test(k)) {
        const n = toNumber(v);
        if (n != null) return n;
      }
    }
    for (const v of Object.values(node)) {
      const r = findFollowers(v, depth + 1);
      if (r != null) return r;
    }
  }
  return null;
}

// Follower counts barely move minute-to-minute — cache hard to protect quota.
const cache = new Map(); // `${platform}:${handle}` -> { followers, fetchedAt }
const TTL_MS = (Number(process.env.SOCIAL_CACHE_HOURS) || 12) * 3600 * 1000;

// GET /api/socials/followers?platform=instagram&handle=shedeursanders
router.get('/followers', requireAuth, async (req, res) => {
  try {
    const platform = String(req.query.platform || '').toLowerCase();
    const handle = String(req.query.handle || '').trim().replace(/^@+/, '');
    const provider = PROVIDERS[platform];
    if (!provider) return res.status(400).json({ error: 'unsupported platform' });
    if (!handle) return res.status(400).json({ error: 'handle required' });

    const key = process.env.RAPIDAPI_KEY;
    if (!key) return res.json({ platform, handle, followers: null, source: 'unconfigured' });

    const cacheKey = `${platform}:${handle.toLowerCase()}`;
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.fetchedAt < TTL_MS) {
      return res.json({ platform, handle, followers: hit.followers, cached: true, fetchedAt: new Date(hit.fetchedAt).toISOString() });
    }

    const url = `https://${provider.host}${provider.path(handle)}`;
    const r = await fetch(url, { headers: { 'X-RapidAPI-Key': key, 'X-RapidAPI-Host': provider.host } });
    if (!r.ok) return res.status(502).json({ error: `provider responded ${r.status}` });

    const json = await r.json();
    const followers = findFollowers(json);
    if (followers == null) return res.status(502).json({ error: 'follower count not found in provider response' });

    cache.set(cacheKey, { followers, fetchedAt: Date.now() });
    res.json({ platform, handle, followers, cached: false, fetchedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Candidate highlight video IDs for an athlete, cached to protect YouTube quota.
// The client plays them in order and skips any the rights holder blocks from
// embedding, so a reel always ends up playing on the profile.
const reelCache = new Map(); // key -> { ids, fetchedAt }
const REEL_TTL_MS = (Number(process.env.REEL_CACHE_HOURS) || 6) * 3600 * 1000;

// GET /api/socials/reels?name=&school=&position=&sport=
router.get('/reels', requireAuth, async (req, res) => {
  try {
    const name = String(req.query.name || '').trim();
    if (!name) return res.json({ ids: [] });
    const school = String(req.query.school || '').trim();
    const position = String(req.query.position || '').trim();
    const sport = String(req.query.sport || '').trim();

    const cacheKey = [name, school, position, sport].join('|').toLowerCase();
    const hit = reelCache.get(cacheKey);
    if (hit && Date.now() - hit.fetchedAt < REEL_TTL_MS) {
      return res.json({ ids: hit.ids, cached: true });
    }

    const ids = await findYouTubeReelIds({ name, school, position, sport });
    reelCache.set(cacheKey, { ids, fetchedAt: Date.now() });
    res.json({ ids, cached: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
