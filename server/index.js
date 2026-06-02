import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { Server } from 'socket.io';
import mongoose from 'mongoose';

import authRoutes from './routes/auth.js';
import Deal from './models/Deal.js';
import dealRoutes from './routes/deals.js';
import campaignRoutes from './routes/campaigns.js';
import contentRoutes from './routes/content.js';
import analyticsRoutes from './routes/analytics.js';
import activityRoutes from './routes/activity.js';
import timelogRoutes from './routes/timelogs.js';
import cfbdRoutes from './routes/cfbd.js';
import socialsRoutes from './routes/socials.js';
import crmRoutes from './routes/crm.js';
import exportRoutes from './routes/export.js';
import ownerRoutes from './routes/owner.js';
import inviteRoutes from './routes/invites.js';
import billingRoutes from './routes/billing.js';
import systemRoutes from './routes/system.js';
import adminRoutes from './routes/admin.js';
import { licenseGate } from './middleware/license.js';
import { getLicenseState } from './lib/license.js';
import User from './models/User.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IS_PROD = process.env.NODE_ENV === 'production';

// ── Env guards ───────────────────────────────────────────────────────────────
// JWT must be signed with a stable secret. In prod a missing/placeholder secret is
// a deploy mistake (everyone gets logged out on restart) — warn loudly. Either way,
// generate an ephemeral one so the process never crashes for lack of config.
const DEFAULT_JWT = 'your-super-secret-jwt-key-change-this';
if (!process.env.JWT_SECRET || process.env.JWT_SECRET === DEFAULT_JWT) {
  if (IS_PROD) {
    console.error('WARNING: JWT_SECRET is missing/default in production. Set a strong JWT_SECRET in Railway — using a temporary one for now (sessions reset on restart).');
  }
  process.env.JWT_SECRET = crypto.randomBytes(48).toString('hex');
}
if (IS_PROD && !process.env.OWNER_KEY) {
  console.warn('NOTE: OWNER_KEY is not set — remote lock/unlock controls are disabled. Set OWNER_KEY in Railway to enable them.');
}

const app = express();
const httpServer = createServer(app);

// Railway terminates TLS at its proxy; trust it so req.ip / rate limits are correct.
app.set('trust proxy', 1);

const corsOrigins = (process.env.CORS_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
const corsOptions = corsOrigins.length ? { origin: corsOrigins } : {};

const io = new Server(httpServer, {
  cors: { origin: corsOrigins.length ? corsOrigins : '*', methods: ['GET', 'POST'] }
});

// Middleware
app.use(cors(corsOptions));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
// Capture the raw request body for the Stripe webhook so its signature can be
// verified (Stripe signs the exact bytes; a parsed body won't match).
app.use(express.json({
  limit: '10mb',
  verify: (req, res, buf) => {
    if (req.originalUrl === '/api/billing/webhook') req.rawBody = buf;
  }
}));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Static files — uploads live on a persistent Railway Volume in prod (UPLOAD_DIR).
const uploadsDir = process.env.UPLOAD_DIR || './uploads';
try { fs.mkdirSync(path.resolve(uploadsDir), { recursive: true }); } catch { /* created on first write otherwise */ }
app.use('/uploads', express.static(path.resolve(uploadsDir)));
app.use(express.static(path.join(__dirname, '../client')));

// Health check — always reachable, even when the app is licence-locked.
app.get('/api/health', async (req, res) => {
  let lic = {};
  try { const s = await getLicenseState(); lic = { locked: s.locked, paidThrough: s.paidThrough }; } catch { /* ignore */ }
  res.json({
    status: 'ok',
    db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    uptime: process.uptime(),
    ...lic
  });
});

// Vendor control surface + public lock status — mounted BEFORE the licence gate so
// the owner can always unlock and the client can always read lock state.
app.use('/api/owner', ownerRoutes);
app.use('/api/system', systemRoutes);
// Billing is mounted BEFORE the licence gate so Stripe webhooks (and checkout)
// keep working regardless of app lock state — payments must never be blocked.
app.use('/api/billing', billingRoutes);

// Licence gate — every other /api route is blocked with 503 when the app is locked.
app.use('/api', licenseGate);

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/invites', inviteRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/deals', dealRoutes);
app.use('/api/campaigns', campaignRoutes);
app.use('/api/content', contentRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/activity', activityRoutes);
app.use('/api/timelogs', timelogRoutes);
app.use('/api/cfbd', cfbdRoutes);
app.use('/api/socials', socialsRoutes);
app.use('/api/crm', crmRoutes);
app.use('/api/export', exportRoutes);

// Unknown API routes must 404 as JSON — never fall through to the SPA, or clients
// (e.g. the media-kit export) silently receive index.html instead of their payload.
app.use('/api', (req, res) => {
  res.status(404).json({ error: `Not found: ${req.method} ${req.originalUrl}` });
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/index.html'));
});

// Socket.io — real-time notifications
io.on('connection', (socket) => {
  socket.on('join', (userId) => {
    if (userId) socket.join(`user:${userId}`);
  });
  socket.on('disconnect', () => {});
});

export { io };

// Start HTTP server immediately so healthcheck passes
const PORT = process.env.PORT || 5000;
httpServer.listen(PORT, () => console.log(`Digital NIL server running on port ${PORT}`));

// Connect to MongoDB — falls back to in-memory Mongo if the URI is a placeholder
// or unreachable, so the app stays usable for local dev without any DB setup.
const PLACEHOLDER_URI = /username:password@cluster\.mongodb\.net/i;
const seedTestUsers = async () => {
  if (!process.env.SEED_TEST_USERS && process.env.NODE_ENV === 'production') return;
  // Demo logins skip the verify + onboarding gates (verified + onboarded true).
  const seeds = [
    { email: 'agent@dnil.test', password: 'test1234', name: 'Test Agent', role: 'agent', agency: 'Digital NIL Sports' },
    { email: 'athlete@dnil.test', password: 'test1234', name: 'Test Athlete', role: 'athlete', sport: 'Football', school: 'Digital NIL University', position: 'WR' },
    { email: 'brand@dnil.test', password: 'test1234', name: 'Test Brand', role: 'brand', company: 'Digital NIL Apparel', industry: 'Apparel' }
  ];
  for (const s of seeds) {
    const exists = await User.findOne({ email: s.email });
    if (!exists) {
      await User.create({ ...s, verified: true, onboarded: true });
      console.log(`  + seeded ${s.role.padEnd(7)} ${s.email}`);
    }
  }
};

// The customer's super-user. Seeds from ADMIN_EMAIL/ADMIN_PASSWORD when provided
// (any environment, incl. production); otherwise a dev default so the console is
// reachable out of the box. Idempotent — never clobbers an existing admin.
const seedAdmin = async () => {
  const isProd = process.env.NODE_ENV === 'production';
  const email = (process.env.ADMIN_EMAIL || (isProd ? '' : 'admin@dnil.test')).toLowerCase().trim();
  const password = process.env.ADMIN_PASSWORD || (isProd ? '' : 'admin1234');
  if (!email || !password) return; // no creds in prod = no auto-admin (set the env vars)
  const exists = await User.findOne({ email });
  if (exists) {
    if (exists.role !== 'admin') { exists.role = 'admin'; await exists.save(); }
    return;
  }
  await User.create({
    email, password, name: 'Administrator', role: 'admin',
    verified: true, onboarded: true
  });
  console.log(`  + seeded admin   ${email}`);
};

// Grandfather every account that predates the verify/onboarding gate so existing
// users aren't suddenly trapped on the new screens. Runs on every boot; only ever
// touches docs missing the new field, so it's a no-op once migrated.
const migrateGate = async () => {
  const r = await User.updateMany(
    { onboarded: { $exists: false } },
    { $set: { onboarded: true, verified: true } }
  );
  if (r.modifiedCount) console.log(`  ~ grandfathered ${r.modifiedCount} pre-gate account(s)`);
};

const seedAthletes = async () => {
  if (!process.env.SEED_TEST_USERS && process.env.NODE_ENV === 'production') return;
  const athletes = [
    {
      name: 'Travis Hunter', school: 'Colorado', position: 'WR', jerseyNumber: 12,
      classYear: 'Junior', graduationYear: 2025, heightDisplay: "6'1\"", weightLbs: 185, fortyTime: 4.4,
      bio: 'Heisman-winning two-way phenom who stars at both wide receiver and cornerback for Colorado.',
      draftRound: '1st', draftTrend: 'up', interestedTeams: ['Cleveland Browns', 'Tennessee Titans', 'NY Giants'],
      socialHandles: [
        { platform: 'instagram', handle: 'travishunterjr', followers: 2400000, connected: true },
        { platform: 'twitter', handle: 'TravisHunterJr', followers: 620000, connected: true },
        { platform: 'tiktok', handle: 'travishunter', followers: 1100000, connected: true }
      ],
      nilValue: 6500000, totalEarnings: 4200000, dealsCompleted: 18
    },
    {
      name: 'Shedeur Sanders', school: 'Colorado', position: 'QB', jerseyNumber: 2,
      classYear: 'Senior', graduationYear: 2025, heightDisplay: "6'2\"", weightLbs: 215, fortyTime: 4.75,
      bio: 'Accurate, poised pocket passer who led Colorado\'s offense and is the son of Deion Sanders.',
      draftRound: '1st', draftTrend: 'up', interestedTeams: ['NY Giants', 'Las Vegas Raiders', 'Pittsburgh Steelers'],
      socialHandles: [
        { platform: 'instagram', handle: 'shedeursanders', followers: 2100000, connected: true },
        { platform: 'twitter', handle: 'ShedeurSanders', followers: 800000, connected: true },
        { platform: 'tiktok', handle: 'shedeursanders', followers: 900000, connected: true }
      ],
      nilValue: 6200000, totalEarnings: 4500000, dealsCompleted: 22
    },
    {
      name: 'Nico Iamaleava', school: 'UCLA', position: 'QB', jerseyNumber: 8,
      classYear: 'Sophomore', graduationYear: 2027, heightDisplay: "6'6\"", weightLbs: 215, fortyTime: 4.7,
      bio: 'Big-armed dual-threat quarterback who transferred to UCLA in 2025 after a hyped run at Tennessee.',
      draftRound: '2nd - 3rd', draftTrend: 'up', interestedTeams: ['Tennessee Titans', 'New Orleans Saints', 'Carolina Panthers'],
      socialHandles: [
        { platform: 'instagram', handle: 'nicoiamaleava', followers: 380000, connected: true },
        { platform: 'twitter', handle: 'IamaleavaNico', followers: 120000, connected: true }
      ],
      nilValue: 2900000, totalEarnings: 1800000, dealsCompleted: 9
    },
    {
      name: 'Quinn Ewers', school: 'Texas', position: 'QB', jerseyNumber: 3,
      classYear: 'Junior', graduationYear: 2025, heightDisplay: "6'2\"", weightLbs: 205, fortyTime: 4.8,
      bio: 'Former five-star recruit and steady starter who guided Texas to the College Football Playoff.',
      draftRound: '2nd - 3rd', draftTrend: 'steady', interestedTeams: ['Dallas Cowboys', 'Houston Texans', 'Minnesota Vikings'],
      socialHandles: [
        { platform: 'instagram', handle: 'quinnewers', followers: 540000, connected: true },
        { platform: 'twitter', handle: 'QuinnEwers', followers: 210000, connected: true }
      ],
      nilValue: 2400000, totalEarnings: 1600000, dealsCompleted: 11
    },
    {
      name: 'Carson Beck', school: 'Georgia', position: 'QB', jerseyNumber: 15,
      classYear: 'Senior', graduationYear: 2025, heightDisplay: "6'4\"", weightLbs: 220, fortyTime: 4.85,
      bio: 'Prototypical pocket passer who started for back-to-back-contending Georgia teams.',
      draftRound: '2nd', draftTrend: 'down', interestedTeams: ['Atlanta Falcons', 'Jacksonville Jaguars', 'NY Jets'],
      socialHandles: [
        { platform: 'instagram', handle: 'carsonbeck', followers: 410000, connected: true },
        { platform: 'twitter', handle: 'CarsonBeck', followers: 95000, connected: true }
      ],
      nilValue: 1900000, totalEarnings: 1300000, dealsCompleted: 8
    },
    {
      name: 'Dillon Gabriel', school: 'Oregon', position: 'QB', jerseyNumber: 8,
      classYear: 'Senior', graduationYear: 2025, heightDisplay: "5'11\"", weightLbs: 200, fortyTime: 4.7,
      bio: 'Prolific, experienced lefty passer who broke career records on his way to Oregon.',
      draftRound: '4th - 5th', draftTrend: 'steady', interestedTeams: ['Las Vegas Raiders', 'Seattle Seahawks', 'New England Patriots'],
      socialHandles: [
        { platform: 'instagram', handle: 'dillongabriel_', followers: 260000, connected: true },
        { platform: 'twitter', handle: 'DillonGabriel_', followers: 88000, connected: true }
      ],
      nilValue: 1200000, totalEarnings: 850000, dealsCompleted: 6
    },
    {
      name: 'Jeremiah Smith', school: 'Ohio State', position: 'WR', jerseyNumber: 4,
      classYear: 'Freshman', graduationYear: 2027, heightDisplay: "6'3\"", weightLbs: 215, fortyTime: 4.4,
      bio: 'Explosive, physically dominant freshman receiver who emerged as Ohio State\'s top target.',
      draftRound: '1st', draftTrend: 'up', interestedTeams: ['Cincinnati Bengals', 'Chicago Bears', 'Arizona Cardinals'],
      socialHandles: [
        { platform: 'instagram', handle: 'jeremiahsmith', followers: 720000, connected: true },
        { platform: 'twitter', handle: 'JJ_smith1ohio', followers: 180000, connected: true },
        { platform: 'tiktok', handle: 'jeremiahsmith', followers: 340000, connected: true }
      ],
      nilValue: 4000000, totalEarnings: 2200000, dealsCompleted: 12
    },
    {
      name: 'Will Howard', school: 'Ohio State', position: 'QB', jerseyNumber: 18,
      classYear: 'Senior', graduationYear: 2025, heightDisplay: "6'4\"", weightLbs: 235, fortyTime: 4.8,
      bio: 'Veteran transfer quarterback who steered Ohio State to a national championship run.',
      draftRound: '5th - 6th', draftTrend: 'up', interestedTeams: ['Pittsburgh Steelers', 'Cleveland Browns', 'Kansas City Chiefs'],
      socialHandles: [
        { platform: 'instagram', handle: 'willhoward', followers: 230000, connected: true },
        { platform: 'twitter', handle: 'WillHoward_18', followers: 75000, connected: true }
      ],
      nilValue: 1100000, totalEarnings: 700000, dealsCompleted: 5
    },
    {
      name: 'Cam Ward', school: 'Miami', position: 'QB', jerseyNumber: 1,
      classYear: 'Senior', graduationYear: 2025, heightDisplay: "6'2\"", weightLbs: 220, fortyTime: 4.7,
      bio: 'Improvisational gunslinger whose breakout season at Miami vaulted him up draft boards.',
      draftRound: '1st', draftTrend: 'up', interestedTeams: ['Tennessee Titans', 'Cleveland Browns', 'NY Giants'],
      socialHandles: [
        { platform: 'instagram', handle: 'camward', followers: 480000, connected: true },
        { platform: 'twitter', handle: 'camward', followers: 150000, connected: true }
      ],
      nilValue: 2600000, totalEarnings: 1500000, dealsCompleted: 9
    },
    {
      name: 'Ashton Jeanty', school: 'Boise State', position: 'RB', jerseyNumber: 2,
      classYear: 'Junior', graduationYear: 2025, heightDisplay: "5'9\"", weightLbs: 215, fortyTime: 4.45,
      bio: 'Tackle-breaking workhorse back whose record-setting season made him a Heisman finalist.',
      draftRound: '1st', draftTrend: 'up', interestedTeams: ['Las Vegas Raiders', 'Dallas Cowboys', 'Denver Broncos'],
      socialHandles: [
        { platform: 'instagram', handle: 'ashtonjeanty', followers: 560000, connected: true },
        { platform: 'twitter', handle: 'JeantyAshton', followers: 190000, connected: true },
        { platform: 'tiktok', handle: 'ashtonjeanty', followers: 410000, connected: true }
      ],
      nilValue: 3500000, totalEarnings: 1900000, dealsCompleted: 13
    },
    {
      name: 'Ollie Gordon II', school: 'Oklahoma State', position: 'RB', jerseyNumber: 0,
      classYear: 'Junior', graduationYear: 2025, heightDisplay: "6'2\"", weightLbs: 215, fortyTime: 4.55,
      bio: 'Big, downhill runner and Doak Walker Award winner who carried Oklahoma State\'s offense.',
      draftRound: '3rd - 4th', draftTrend: 'down', interestedTeams: ['Dallas Cowboys', 'Houston Texans', 'Tampa Bay Buccaneers'],
      socialHandles: [
        { platform: 'instagram', handle: 'olliegordon', followers: 240000, connected: true },
        { platform: 'twitter', handle: 'OllieGordonII', followers: 70000, connected: true }
      ],
      nilValue: 1400000, totalEarnings: 900000, dealsCompleted: 7
    },
    {
      name: 'Omarion Hampton', school: 'North Carolina', position: 'RB', jerseyNumber: 28,
      classYear: 'Junior', graduationYear: 2025, heightDisplay: "6'0\"", weightLbs: 220, fortyTime: 4.5,
      bio: 'Powerful, high-volume back who was one of the most productive runners in the country at UNC.',
      draftRound: '1st - 2nd', draftTrend: 'up', interestedTeams: ['Carolina Panthers', 'Dallas Cowboys', 'LA Chargers'],
      socialHandles: [
        { platform: 'instagram', handle: 'omarionhampton', followers: 210000, connected: true },
        { platform: 'twitter', handle: 'omarionhampton', followers: 60000, connected: true }
      ],
      nilValue: 1600000, totalEarnings: 1000000, dealsCompleted: 6
    },
    {
      name: 'Luther Burden III', school: 'Missouri', position: 'WR', jerseyNumber: 3,
      classYear: 'Junior', graduationYear: 2025, heightDisplay: "6'0\"", weightLbs: 205, fortyTime: 4.45,
      bio: 'Dynamic slot receiver with elite run-after-catch ability and big-play upside at Missouri.',
      draftRound: '1st - 2nd', draftTrend: 'steady', interestedTeams: ['Kansas City Chiefs', 'Chicago Bears', 'St. Louis (LA) Rams'],
      socialHandles: [
        { platform: 'instagram', handle: 'lutherburden', followers: 330000, connected: true },
        { platform: 'twitter', handle: 'lutherburden3', followers: 110000, connected: true }
      ],
      nilValue: 2200000, totalEarnings: 1300000, dealsCompleted: 10
    },
    {
      name: 'Tetairoa McMillan', school: 'Arizona', position: 'WR', jerseyNumber: 4,
      classYear: 'Junior', graduationYear: 2025, heightDisplay: "6'5\"", weightLbs: 210, fortyTime: 4.5,
      bio: 'Tall, smooth contested-catch specialist who became Arizona\'s go-to downfield weapon.',
      draftRound: '1st', draftTrend: 'up', interestedTeams: ['Arizona Cardinals', 'New England Patriots', 'NY Jets'],
      socialHandles: [
        { platform: 'instagram', handle: 'tetairoamcmillan', followers: 290000, connected: true },
        { platform: 'twitter', handle: 'Tetairoa_Mac', followers: 85000, connected: true }
      ],
      nilValue: 2300000, totalEarnings: 1400000, dealsCompleted: 8
    },
    {
      name: 'Jalen Milroe', school: 'Alabama', position: 'QB', jerseyNumber: 4,
      classYear: 'Junior', graduationYear: 2025, heightDisplay: "6'2\"", weightLbs: 220, fortyTime: 4.4,
      bio: 'Explosive dual-threat quarterback whose running ability made him Alabama\'s offensive engine.',
      draftRound: '2nd - 3rd', draftTrend: 'steady', interestedTeams: ['Atlanta Falcons', 'Las Vegas Raiders', 'Pittsburgh Steelers'],
      socialHandles: [
        { platform: 'instagram', handle: 'jalenmilroe', followers: 470000, connected: true },
        { platform: 'twitter', handle: 'jalenmilroe', followers: 160000, connected: true },
        { platform: 'tiktok', handle: 'jalenmilroe', followers: 220000, connected: true }
      ],
      nilValue: 2700000, totalEarnings: 1700000, dealsCompleted: 11
    },
    {
      name: 'Kaleb Johnson', school: 'Iowa', position: 'RB', jerseyNumber: 2,
      classYear: 'Junior', graduationYear: 2025, heightDisplay: "6'0\"", weightLbs: 225, fortyTime: 4.5,
      bio: 'Patient, one-cut zone runner who broke out for a huge season as Iowa\'s feature back.',
      draftRound: '3rd - 4th', draftTrend: 'up', interestedTeams: ['Chicago Bears', 'Denver Broncos', 'Green Bay Packers'],
      socialHandles: [
        { platform: 'instagram', handle: 'kalebjohnson', followers: 140000, connected: true },
        { platform: 'twitter', handle: 'kalebjohnson', followers: 45000, connected: true }
      ],
      nilValue: 1100000, totalEarnings: 650000, dealsCompleted: 5
    }
  ];
  // CFBD/ESPN athlete ids → power live stats + ESPN headshots for the seeded roster.
  const ESPN_IDS = {
    'Travis Hunter': '4685415', 'Shedeur Sanders': '4432762', 'Nico Iamaleava': '4870799',
    'Quinn Ewers': '4889929', 'Carson Beck': '4430841', 'Dillon Gabriel': '4427238',
    'Jeremiah Smith': '5079720', 'Will Howard': '4429955', 'Cam Ward': '4688380',
    'Ashton Jeanty': '4890973', 'Ollie Gordon II': '4711533', 'Omarion Hampton': '4685382',
    'Luther Burden III': '4685278', 'Tetairoa McMillan': '4685472', 'Jalen Milroe': '4432734',
    'Kaleb Johnson': '4819231'
  };
  const agent = await User.findOne({ email: 'agent@dnil.test' });
  const seededIds = [];
  for (const a of athletes) {
    const email = a.name.toLowerCase().replace(/[^a-z ]/g, '').trim().replace(/\s+/g, '.') + '@athlete.dnil';
    const existing = await User.findOne({ email });
    if (existing) { seededIds.push(existing._id); continue; }
    const espnId = ESPN_IDS[a.name] || '';
    const created = await User.create({
      email,
      password: 'test1234',
      role: 'athlete',
      verified: true,
      managed: true,
      featured: true,            // showcase roster = the admin's default "top 20"
      proStatus: 'collegiate',
      sport: 'Football',
      highlightUrl: '',
      agentId: agent?._id,
      ...a,
      cfbPlayerId: espnId,
      avatar: espnId ? `https://a.espncdn.com/i/headshots/college-football/players/full/${espnId}.png` : ''
    });
    seededIds.push(created._id);
    console.log(`  + seeded athlete ${email}`);
  }
  // Reconcile current team for the managed showcase roster. The seeder skips
  // athletes that already exist, so a corrected `school` (e.g. a transfer like
  // Nico Iamaleava → UCLA) never reaches docs seeded under the old value. Push
  // school/position/bio from the seed array onto the managed seed accounts so the
  // profile always reflects the athlete's current team. Scoped to managed seed
  // accounts so it never clobbers a real athlete's self-edited profile.
  for (const a of athletes) {
    const email = a.name.toLowerCase().replace(/[^a-z ]/g, '').trim().replace(/\s+/g, '.') + '@athlete.dnil';
    await User.updateOne(
      { email, managed: true, school: { $ne: a.school } },
      { $set: { school: a.school, position: a.position, jerseyNumber: a.jerseyNumber, bio: a.bio } }
    );
  }
  // Idempotently flag the showcase roster as featured (covers athletes seeded
  // before the featured field existed). Cap at the first 20.
  await User.updateMany({ _id: { $in: seededIds.slice(0, 20) } }, { $set: { featured: true } });
  // Keep the seed agent's roster consistent (idempotent: only set when currently empty)
  if (agent && (!agent.athletes || agent.athletes.length === 0)) {
    agent.athletes = seededIds;
    await agent.save();
  }
};

// Real-brand sponsors + a marketplace of sample deals so the app looks alive on
// first boot. Idempotent: brands keyed by email, deals keyed by title.
const seedBrandsAndDeals = async () => {
  if (!process.env.SEED_TEST_USERS && process.env.NODE_ENV === 'production') return;

  // Logos: Simple Icons CDN (white glyphs suit the dark theme) where available,
  // Google's favicon service for the brands Simple Icons doesn't carry.
  const si = (slug) => `https://cdn.simpleicons.org/${slug}/white`;
  const fav = (domain) => `https://www.google.com/s2/favicons?sz=128&domain=${domain}`;
  const brands = [
    { company: 'Nike', domain: 'nike.com', industry: 'Athletic Apparel & Footwear', bio: 'Just Do It. The world\'s leading athletic brand.', logo: si('nike') },
    { company: 'Jordan Brand', domain: 'jordan.com', industry: 'Footwear & Streetwear', bio: 'The Jumpman legacy — performance and culture since 1985.', logo: si('jordan') },
    { company: 'Oakley', domain: 'oakley.com', industry: 'Performance Eyewear', bio: 'High-performance eyewear engineered for elite athletes.', logo: fav('oakley.com') },
    { company: 'JPMorgan Chase', domain: 'chase.com', industry: 'Financial Services', bio: 'Banking, cards, and financial tools for the next generation.', logo: si('chase') },
    { company: 'Gatorade', domain: 'gatorade.com', industry: 'Sports Nutrition', bio: 'Fuel for athletes at every level. Is it in you?', logo: fav('gatorade.com') },
    { company: 'Red Bull', domain: 'redbull.com', industry: 'Energy Drinks', bio: 'Red Bull gives you wings.', logo: si('redbull') },
    { company: 'Under Armour', domain: 'underarmour.com', industry: 'Athletic Apparel', bio: 'The brand that makes you better. Protect this house.', logo: si('underarmour') },
    { company: 'adidas', domain: 'adidas.com', industry: 'Athletic Apparel', bio: 'Through sport, we have the power to change lives.', logo: si('adidas') },
    { company: 'Beats by Dre', domain: 'beatsbydre.com', industry: 'Consumer Audio', bio: 'Premium audio engineered for the culture.', logo: si('beatsbydre') },
    { company: 'CELSIUS', domain: 'celsius.com', industry: 'Energy Drinks', bio: 'Live Fit. Essential energy for an active lifestyle.', logo: fav('celsius.com') },
    { company: 'New Balance', domain: 'newbalance.com', industry: 'Footwear & Apparel', bio: 'Fearlessly Independent Since 1906.', logo: si('newbalance') },
    { company: 'Bose', domain: 'bose.com', industry: 'Consumer Audio', bio: 'Better sound through research.', logo: si('bose') }
  ];

  const brandMap = {};
  for (const b of brands) {
    const email = `${b.domain.split('.')[0]}@brand.dnil`;
    let u = await User.findOne({ email });
    if (!u) {
      u = await User.create({
        email, password: 'test1234', name: b.company, role: 'brand', verified: true,
        company: b.company, industry: b.industry, website: `https://www.${b.domain}`,
        bio: b.bio, logo: b.logo
      });
      console.log(`  + seeded brand   ${email}`);
    } else if (u.logo !== b.logo) {
      // Self-heal logos for brands seeded before the URL source changed
      u.logo = b.logo;
      await u.save();
      console.log(`  ~ updated logo   ${email}`);
    }
    brandMap[b.company] = u._id;
  }

  // Resolve a seeded athlete's id from their display name (matches seedAthletes' email scheme)
  const athleteId = async (name) => {
    const email = name.toLowerCase().replace(/[^a-z ]/g, '').trim().replace(/\s+/g, '.') + '@athlete.dnil';
    const a = await User.findOne({ email }).select('_id');
    return a?._id;
  };

  const DAY = 86400000;
  const now = Date.now();
  const d = (days) => new Date(now + days * DAY);

  const deals = [
    {
      title: 'Nike Air Max Spring Launch',
      brandCompany: 'Nike', type: 'ambassador', status: 'active', athlete: 'Travis Hunter',
      description: 'Headline the Air Max spring drop with in-feed and on-field content across game week.',
      platforms: ['instagram', 'tiktok'], sports: ['Football'], minFollowers: 500000,
      compensation: { amount: 45000, type: 'flat' }, disclosureTag: '#NikePartner #ad',
      deliverables: [
        { type: 'reel', platform: 'instagram', description: 'Unboxing + warmup reel in the new Air Max' },
        { type: 'post', platform: 'instagram', description: 'Game-day carousel featuring the shoe' }
      ],
      startDate: d(-18), endDate: d(42)
    },
    {
      title: 'Nike Training Club Creator Push',
      brandCompany: 'Nike', type: 'social_post', status: 'open',
      description: 'Show your off-season workout using the Nike Training Club app. Authentic, sweat-equity content.',
      platforms: ['instagram', 'youtube'], sports: ['Football', 'Basketball'], minFollowers: 100000,
      compensation: { amount: 18000, type: 'flat' }, disclosureTag: '#ad',
      deliverables: [{ type: 'video', platform: 'youtube', description: 'Day-in-the-life training session' }],
      expiresAt: d(35)
    },
    {
      title: 'Jordan Brand Game Day Capsule',
      brandCompany: 'Jordan Brand', type: 'ambassador', status: 'active', athlete: 'Shedeur Sanders',
      description: 'Become the face of the next Jumpman capsule with pregame tunnel and lifestyle content.',
      platforms: ['instagram'], sports: ['Football'], minFollowers: 750000,
      compensation: { amount: 60000, type: 'flat' }, disclosureTag: '#Jordan #ad',
      deliverables: [
        { type: 'post', platform: 'instagram', description: 'Tunnel walk fit pic in the capsule' },
        { type: 'story', platform: 'instagram', description: '3-frame story of the drop' }
      ],
      startDate: d(-25), endDate: d(60)
    },
    {
      title: 'Air Jordan Retro Story Series',
      brandCompany: 'Jordan Brand', type: 'social_post', status: 'open',
      description: 'Weekly story series styling Air Jordan retros on and off the field.',
      platforms: ['instagram'], sports: ['Football', 'Basketball'], minFollowers: 50000,
      compensation: { amount: 12000, type: 'per_post' }, disclosureTag: '#ad',
      deliverables: [{ type: 'story', platform: 'instagram', description: 'Styling story per drop' }],
      expiresAt: d(45)
    },
    {
      title: 'Oakley Performance Eyewear Campaign',
      brandCompany: 'Oakley', type: 'social_post', status: 'open',
      description: 'Feature Oakley Prizm lenses in your training and competition routine.',
      platforms: ['instagram', 'tiktok'], sports: ['Football', 'Baseball', 'Track'], minFollowers: 75000,
      compensation: { amount: 9000, type: 'flat' }, disclosureTag: '#OakleyPartner #ad',
      deliverables: [{ type: 'reel', platform: 'tiktok', description: 'Field-test reel with Prizm lenses' }],
      expiresAt: d(30)
    },
    {
      title: 'Oakley Prizm Field Test',
      brandCompany: 'Oakley', type: 'video', status: 'completed', athlete: 'Jeremiah Smith',
      description: 'Long-form review breaking down Oakley Prizm clarity in live game footage.',
      platforms: ['youtube'], sports: ['Football'], minFollowers: 200000,
      compensation: { amount: 15000, type: 'flat' }, disclosureTag: '#ad',
      deliverables: [{ type: 'video', platform: 'youtube', description: 'Full Prizm review video', status: 'posted' }],
      startDate: d(-90), endDate: d(-30),
      metrics: { impressions: 1280000, clicks: 41000, engagements: 96000, reach: 870000 }
    },
    {
      title: 'Chase Financial Literacy for Athletes',
      brandCompany: 'JPMorgan Chase', type: 'appearance', status: 'open',
      description: 'Join a Chase-hosted workshop on managing NIL income and appear in recap content.',
      platforms: ['instagram', 'youtube'], sports: ['Football', 'Basketball', 'Soccer'], minFollowers: 25000,
      compensation: { amount: 25000, type: 'flat' }, disclosureTag: '#ChasePartner #ad',
      deliverables: [{ type: 'appearance', platform: 'any', description: 'In-person workshop + recap post' }],
      expiresAt: d(50)
    },
    {
      title: 'Gatorade Fuel Tomorrow',
      brandCompany: 'Gatorade', type: 'ambassador', status: 'active', athlete: 'Ashton Jeanty',
      description: 'Season-long ambassadorship spotlighting hydration and recovery routines.',
      platforms: ['instagram', 'twitter'], sports: ['Football'], minFollowers: 300000,
      compensation: { amount: 50000, type: 'flat' }, disclosureTag: '#GatoradePartner #ad',
      deliverables: [
        { type: 'post', platform: 'instagram', description: 'Pre-game hydration ritual post' },
        { type: 'tweet', platform: 'twitter', description: 'Recovery tip thread' }
      ],
      startDate: d(-30), endDate: d(120)
    },
    {
      title: 'Red Bull Gameday Energy',
      brandCompany: 'Red Bull', type: 'social_post', status: 'open',
      description: 'Capture your gameday prep fueled by Red Bull. High-energy, vertical-first.',
      platforms: ['instagram', 'tiktok'], sports: ['Football', 'Basketball', 'Esports'], minFollowers: 150000,
      compensation: { amount: 20000, type: 'per_post' }, disclosureTag: '#ad',
      deliverables: [{ type: 'reel', platform: 'tiktok', description: 'Gameday prep reel' }],
      expiresAt: d(28)
    },
    {
      title: 'Under Armour Protect This House',
      brandCompany: 'Under Armour', type: 'ambassador', status: 'open',
      description: 'Multi-month ambassador role featuring UA training gear in your weekly grind.',
      platforms: ['instagram', 'youtube'], sports: ['Football'], minFollowers: 200000,
      compensation: { amount: 35000, type: 'flat' }, disclosureTag: '#UAPartner #ad',
      deliverables: [{ type: 'post', platform: 'instagram', description: 'Weekly gear-in-action post' }],
      expiresAt: d(40)
    },
    {
      title: 'adidas NIL Creator Collective',
      brandCompany: 'adidas', type: 'social_post', status: 'open',
      description: 'Join the adidas creator collective and style the latest three-stripe drops.',
      platforms: ['instagram', 'tiktok'], sports: ['Football', 'Soccer', 'Track'], minFollowers: 80000,
      compensation: { amount: 14000, type: 'flat' }, disclosureTag: '#adidasPartner #ad',
      deliverables: [{ type: 'reel', platform: 'instagram', description: 'Three-stripe styling reel' }],
      expiresAt: d(33)
    },
    {
      title: 'Beats Studio Pro Athlete Drop',
      brandCompany: 'Beats by Dre', type: 'social_post', status: 'completed', athlete: 'Jalen Milroe',
      description: 'Pregame focus content featuring the Beats Studio Pro in your headphone routine.',
      platforms: ['instagram'], sports: ['Football'], minFollowers: 250000,
      compensation: { amount: 22000, type: 'flat' }, disclosureTag: '#ad',
      deliverables: [{ type: 'post', platform: 'instagram', description: 'Pregame focus post', status: 'posted' }],
      startDate: d(-75), endDate: d(-20),
      metrics: { impressions: 940000, clicks: 28000, engagements: 71000, reach: 610000 }
    },
    {
      title: 'CELSIUS Live Fit Tour',
      brandCompany: 'CELSIUS', type: 'social_post', status: 'open',
      description: 'Show how CELSIUS fuels your training between games. Energetic, day-in-the-life vibe.',
      platforms: ['tiktok', 'instagram'], sports: ['Football', 'Basketball', 'Volleyball'], minFollowers: 40000,
      compensation: { amount: 8000, type: 'per_post' }, disclosureTag: '#CELSIUSPartner #ad',
      deliverables: [{ type: 'reel', platform: 'tiktok', description: 'Training fuel reel' }],
      expiresAt: d(25)
    },
    {
      title: 'New Balance Grey Days',
      brandCompany: 'New Balance', type: 'appearance', status: 'open',
      description: 'Celebrate Grey Days with a styling appearance and lifestyle shoot.',
      platforms: ['instagram'], sports: ['Football', 'Track'], minFollowers: 60000,
      compensation: { amount: 16000, type: 'flat' }, disclosureTag: '#NBPartner #ad',
      deliverables: [{ type: 'appearance', platform: 'any', description: 'Grey Days shoot + recap post' }],
      expiresAt: d(38)
    },
    {
      title: 'Bose QuietComfort Focus',
      brandCompany: 'Bose', type: 'video', status: 'completed', athlete: 'Cam Ward',
      description: 'Film review session powered by Bose QuietComfort for distraction-free study.',
      platforms: ['youtube'], sports: ['Football'], minFollowers: 150000,
      compensation: { amount: 19000, type: 'flat' }, disclosureTag: '#ad',
      deliverables: [{ type: 'video', platform: 'youtube', description: 'Film-study session video', status: 'posted' }],
      startDate: d(-65), endDate: d(-15),
      metrics: { impressions: 720000, clicks: 19000, engagements: 52000, reach: 480000 }
    }
  ];

  for (const deal of deals) {
    const exists = await Deal.findOne({ title: deal.title });
    if (exists) continue;
    const { brandCompany, athlete, ...rest } = deal;
    const brand = brandMap[brandCompany];
    if (!brand) continue;
    const athleteRef = athlete ? await athleteId(athlete) : undefined;
    await Deal.create({ ...rest, brand, athlete: athleteRef, isPublic: true });
    console.log(`  + seeded deal    ${deal.title}`);
  }
};

const runSeeds = async () => {
  await migrateGate();   // runs in every environment (grandfathers legacy users)
  await seedAdmin();     // runs in every environment when creds are available
  await seedTestUsers();
  await seedAthletes();
  await seedBrandsAndDeals();
};

const connectMongo = async () => {
  const uri = process.env.MONGODB_URI;
  const real = uri && !PLACEHOLDER_URI.test(uri);

  if (real) {
    try {
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
      console.log('MongoDB connected (real)');
      await runSeeds();
      return;
    } catch (err) {
      if (IS_PROD) {
        // Never fall back to ephemeral in-memory storage in production — that would
        // silently drop real customer data. Keep the server up (healthcheck) and retry.
        console.error('FATAL: cannot reach MONGODB_URI in production:', err.message);
        console.error('Retrying in 5s — verify the MongoDB Atlas connection string in Railway.');
        setTimeout(connectMongo, 5000);
        return;
      }
      console.warn('Real MongoDB unreachable — falling back to in-memory (dev):', err.message);
    }
  } else if (IS_PROD) {
    console.error('FATAL: MONGODB_URI is missing or a placeholder in production. Data will NOT persist.');
    console.error('Set MONGODB_URI to your MongoDB Atlas connection string in Railway, then redeploy.');
    setTimeout(connectMongo, 15000);
    return;
  } else {
    console.log('MongoDB URI is placeholder — using in-memory Mongo for dev');
  }

  // Dev-only ephemeral fallback so the app runs with zero setup.
  try {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    const mem = await MongoMemoryServer.create();
    await mongoose.connect(mem.getUri('digitalni'));
    console.log('MongoDB connected (in-memory) — data resets on restart');
    await runSeeds();
    process.on('SIGINT', async () => { await mem.stop(); process.exit(0); });
  } catch (err) {
    console.error('In-memory MongoDB failed to start:', err.message);
  }
};
connectMongo();
