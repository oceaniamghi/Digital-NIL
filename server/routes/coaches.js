import express from 'express';
import crypto from 'crypto';
import mongoose from 'mongoose';
import User from '../models/User.js';
import Recruit, { RECRUIT_STAGES } from '../models/Recruit.js';
import ContactLog from '../models/ContactLog.js';
import Activity from '../models/Activity.js';
import { requireAuth, requireRole, requireCap, upgradeRequired } from '../middleware/auth.js';
import { planLimit, minPlanForLimit } from '../lib/plans.js';
import { evaluateAction, currentPeriod, nextPeriod } from '../lib/recruiting.js';
import { sendViolationAlert, sendContactDigest } from '../lib/compliance.js';
import { sendEmail } from '../lib/resend.js';

const router = express.Router();
const oid = (id) => mongoose.Types.ObjectId.isValid(id);
const esc = (s) => String(s || '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

// Derive minor status. A prospect is treated as a minor when DOB proves <18 OR
// (no DOB) when flagged as a high-school recruit. Guardian consent is the only way
// to unblock messaging for a minor. Conservative by design.
function isMinor({ dateOfBirth, isHighSchool, gradYear }) {
  if (dateOfBirth) {
    const age = (Date.now() - new Date(dateOfBirth).getTime()) / (365.25 * 86400000);
    return age < 18;
  }
  if (isHighSchool) return true;
  // A grad year still in the future by >0 typically implies a current HS recruit.
  if (gradYear && gradYear >= new Date().getFullYear()) return true;
  return false;
}

// Write an immutable audit row. Never throws into the request path.
async function log(fields) {
  try { return await ContactLog.create(fields); } catch { return null; }
}

// ── PUBLIC: consent landing (athlete or guardian redeems an invite token) ──────
// GET shows who's inviting; POST records consent. Used by off-platform invite-to-
// consent and by guardian consent for minors.
router.get('/consent/:token', async (req, res) => {
  try {
    const r = await Recruit.findOne({ inviteToken: req.params.token })
      .populate('coach', 'name program division sportCoached avatar verifiedProgram');
    if (!r) return res.status(404).json({ valid: false, error: 'This consent link is invalid or has expired.' });
    res.json({
      valid: true, recruitName: r.name, isMinor: r.isMinor,
      coach: r.coach, sport: r.sport, division: r.division
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/consent/:token', async (req, res) => {
  try {
    const { decision, guardianName, guardianEmail } = req.body || {};
    const r = await Recruit.findOne({ inviteToken: req.params.token });
    if (!r) return res.status(404).json({ error: 'This consent link is invalid or has expired.' });

    if (decision === 'decline') {
      r.consentStatus = 'revoked';
      await r.save();
      await log({ recruit: r._id, coach: r.coach, athlete: r.athlete, kind: 'consent', initiatedBy: r.isMinor ? 'guardian' : 'athlete', allowed: true, periodType: 'exempt', body: 'Consent declined' });
      return res.json({ ok: true, consentStatus: r.consentStatus });
    }

    if (r.isMinor) {
      if (!guardianName || !guardianEmail) return res.status(400).json({ error: 'Guardian name and email are required to consent for a minor.' });
      r.consentStatus = 'guardian';
      r.guardianName = guardianName;
      r.guardianEmail = guardianEmail;
      r.guardianConsentAt = new Date();
    } else {
      r.consentStatus = 'athlete';
      r.athleteConsentAt = new Date();
    }
    r.inviteToken = '';
    await r.save();
    await log({ recruit: r._id, coach: r.coach, athlete: r.athlete, kind: 'consent', initiatedBy: r.isMinor ? 'guardian' : 'athlete', channel: 'in_app', allowed: true, periodType: 'exempt', body: r.isMinor ? `Guardian consent by ${guardianName}` : 'Athlete consent granted' });
    res.json({ ok: true, consentStatus: r.consentStatus });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PUBLIC: confirm program verification from the emailed link ──────────────────
// A coach proves they hold an institutional (.edu-style) email; clicking the link
// flips verifiedProgram → true. This is the recruiting-credibility / anti-impersonation
// layer (SportsRecruits/NCSA both verify). Admins can still toggle the badge directly.
router.get('/verify/:token', async (req, res) => {
  try {
    const coach = await User.findOne({ programVerifyToken: req.params.token, role: 'coach' });
    if (!coach) return res.status(404).json({ verified: false, error: 'This verification link is invalid or has expired.' });
    coach.verifiedProgram = true;
    coach.programVerifyToken = '';
    await coach.save();
    await Activity.create({ user: coach._id, type: 'profile_verified', title: 'Program verified', message: `${coach.program || 'Your program'} is now a verified program.` }).catch(() => {});
    res.json({ verified: true, program: coach.program });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// What counts as an institutional email: .edu / .edu.xx / .ac.xx, plus any extra
// domains the operator allowlists (JUCO/NAIA programs that don't use .edu).
const EXTRA_VERIFY_DOMAINS = (process.env.VERIFY_DOMAINS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
function isInstitutionalEmail(email) {
  const m = String(email || '').toLowerCase().match(/@(.+)$/);
  if (!m) return false;
  const domain = m[1];
  if (/(^|\.)edu(\.[a-z]{2})?$/.test(domain) || /\.ac\.[a-z]{2}$/.test(domain)) return true;
  return EXTRA_VERIFY_DOMAINS.some(d => domain === d || domain.endsWith('.' + d));
}

// ── DIRECTORY: browse coaches/programs (any authenticated role; free for athletes)
router.get('/directory', requireAuth, async (req, res) => {
  try {
    const { sport, division, search } = req.query;
    const query = { role: 'coach' };
    if (sport) query.sportCoached = { $regex: String(sport), $options: 'i' };
    if (division) query.division = division;
    if (search) query.$or = [{ name: { $regex: String(search), $options: 'i' } }, { program: { $regex: String(search), $options: 'i' } }];
    const coaches = await User.find(query)
      .select('name avatar program division sportCoached coachTitle recruitingPhilosophy positionNeeds scholarshipStatus introVideoUrl coachRecord verifiedProgram')
      .sort({ verifiedProgram: -1, name: 1 })
      .limit(100);
    res.json({ coaches });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── ATHLETE-INITIATED interest (calendar-EXEMPT; implies consent) ──────────────
// A prospect reaching out to a coach is always permitted under NCAA rules. Paid
// athlete tiers only (contactCoach cap). Creates/refreshes the coach's Recruit and
// records consent (athlete for adults; for minors it still needs guardian consent
// before the coach may reply, so we mark it invited + email the guardian if known).
router.post('/:coachId/interest', requireAuth, requireRole('athlete'), requireCap('contactCoach', 'Messaging coaches'), async (req, res) => {
  try {
    if (!oid(req.params.coachId)) return res.status(400).json({ error: 'Invalid coach' });
    const coach = await User.findOne({ _id: req.params.coachId, role: 'coach' });
    if (!coach) return res.status(404).json({ error: 'Coach not found' });
    const me = req.user;
    const minor = isMinor({ dateOfBirth: me.dateOfBirth, isHighSchool: me.isHighSchool, gradYear: me.graduationYear });

    let r = await Recruit.findOne({ coach: coach._id, athlete: me._id });
    if (!r) {
      r = new Recruit({
        coach: coach._id, athlete: me._id, name: me.name, email: me.email,
        sport: me.sport || coach.sportCoached, division: coach.division || 'D1',
        position: me.position, school: me.school, gradYear: me.graduationYear,
        initiatedBy: 'athlete', isMinor: minor,
        consentStatus: minor ? 'invited' : 'athlete',
        athleteConsentAt: minor ? undefined : new Date()
      });
    } else {
      r.initiatedBy = r.initiatedBy === 'coach' ? 'coach' : 'athlete';
      if (!minor && r.consentStatus !== 'athlete') { r.consentStatus = 'athlete'; r.athleteConsentAt = new Date(); }
    }
    await r.save();

    await log({ recruit: r._id, coach: coach._id, athlete: me._id, kind: 'message', initiatedBy: 'athlete', channel: 'in_app', allowed: true, periodType: 'exempt', body: String(req.body?.message || 'Athlete expressed interest').slice(0, 2000) });
    await Activity.create({ user: coach._id, type: 'deal_offer', title: 'New recruit interest', message: `${me.name} expressed interest in your program` }).catch(() => {});

    res.json({ ok: true, consentStatus: r.consentStatus, needsGuardianConsent: minor });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── COACH-ONLY funnel below this line ──────────────────────────────────────────
router.use(requireAuth, requireRole('coach'));

// Live recruiting-calendar view for the coach's sport/division.
router.get('/calendar', async (req, res) => {
  try {
    const sport = req.query.sport || req.user.sportCoached || 'Football';
    const division = req.query.division || req.user.division || 'D1';
    const now = new Date();
    const period = await currentPeriod(sport, division, now);
    const upcoming = await nextPeriod(sport, division, now);
    res.json({
      sport, division,
      current: period ? { type: period.type, label: period.label, startDate: period.startDate, endDate: period.endDate } : null,
      next: upcoming ? { type: upcoming.type, label: upcoming.label, startDate: upcoming.startDate, endDate: upcoming.endDate } : null
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// List my recruits.
router.get('/recruits', async (req, res) => {
  try {
    const query = { coach: req.user._id };
    if (req.query.stage && RECRUIT_STAGES.includes(req.query.stage)) query.stage = req.query.stage;
    const recruits = await Recruit.find(query).populate('athlete', 'name avatar sport school position').sort({ updatedAt: -1 });
    res.json({ recruits });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Add a recruit. Enforces the plan's recruit limit. Links to a registered athlete
// when athleteId is supplied (consent still required), else creates an off-platform
// prospect (tracking-only until invite-to-consent).
router.post('/recruits', async (req, res) => {
  try {
    const limit = planLimit(req.user, 'recruits');
    if (Number.isFinite(limit)) {
      const count = await Recruit.countDocuments({ coach: req.user._id });
      if (count >= limit) {
        const min = minPlanForLimit('coach', 'recruits', limit + 1);
        return upgradeRequired(res, `Your plan tracks ${limit} recruits. Upgrade${min ? ` to ${min.name}` : ''} to add more.`, min);
      }
    }
    const { athleteId, name, email, phone, sport, division, position, school, gradYear, rating, notes, dateOfBirth, isHighSchool } = req.body || {};

    let athlete = null, finalName = name, finalEmail = email, minor = isMinor({ dateOfBirth, isHighSchool, gradYear });
    if (athleteId) {
      if (!oid(athleteId)) return res.status(400).json({ error: 'Invalid athlete' });
      athlete = await User.findOne({ _id: athleteId, role: 'athlete' }).select('name email sport school position graduationYear dateOfBirth isHighSchool');
      if (!athlete) return res.status(404).json({ error: 'Athlete not found' });
      finalName = athlete.name; finalEmail = athlete.email;
      minor = isMinor({ dateOfBirth: athlete.dateOfBirth, isHighSchool: athlete.isHighSchool, gradYear: athlete.graduationYear });
    }
    if (!finalName) return res.status(400).json({ error: 'name (or athleteId) required' });

    const r = await Recruit.create({
      coach: req.user._id,
      athlete: athlete?._id || null,
      name: finalName, email: finalEmail || '', phone: phone || '',
      sport: sport || athlete?.sport || req.user.sportCoached || '',
      division: division || req.user.division || 'D1',
      position: position || athlete?.position || '',
      school: school || athlete?.school || '',
      gradYear: gradYear || athlete?.graduationYear,
      rating: rating || 'target',
      notes: notes || '',
      initiatedBy: 'coach',
      offPlatform: !athlete,
      isMinor: minor,
      consentStatus: 'none'
    });
    await log({ recruit: r._id, coach: req.user._id, athlete: r.athlete, kind: 'note', initiatedBy: 'coach', allowed: true, periodType: 'exempt', body: 'Recruit added to board' });
    res.status(201).json({ recruit: r });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const RECRUIT_FIELDS = ['name', 'email', 'phone', 'sport', 'division', 'position', 'school', 'gradYear', 'rating', 'notes', 'tags'];
router.put('/recruits/:id', async (req, res) => {
  try {
    const r = await Recruit.findOne({ _id: req.params.id, coach: req.user._id });
    if (!r) return res.status(404).json({ error: 'Recruit not found' });
    for (const k of RECRUIT_FIELDS) if (req.body[k] !== undefined) r[k] = req.body[k];
    await r.save();
    res.json({ recruit: r });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Move a recruit to a new funnel stage.
router.put('/recruits/:id/stage', async (req, res) => {
  try {
    const { stage } = req.body || {};
    if (!RECRUIT_STAGES.includes(stage)) return res.status(400).json({ error: 'Invalid stage' });
    const r = await Recruit.findOneAndUpdate({ _id: req.params.id, coach: req.user._id }, { stage }, { new: true });
    if (!r) return res.status(404).json({ error: 'Recruit not found' });
    await log({ recruit: r._id, coach: req.user._id, athlete: r.athlete, kind: 'note', initiatedBy: 'coach', allowed: true, periodType: 'exempt', body: `Stage → ${stage}` });
    res.json({ recruit: r });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/recruits/:id', async (req, res) => {
  try {
    const r = await Recruit.findOneAndDelete({ _id: req.params.id, coach: req.user._id });
    if (!r) return res.status(404).json({ error: 'Recruit not found' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// The recruit's transparent contact log.
router.get('/recruits/:id/log', async (req, res) => {
  try {
    const r = await Recruit.findOne({ _id: req.params.id, coach: req.user._id });
    if (!r) return res.status(404).json({ error: 'Recruit not found' });
    const entries = await ContactLog.find({ recruit: r._id }).sort({ createdAt: -1 }).limit(200);
    res.json({ entries });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Invite an off-platform prospect (or a minor) to consent. Mints a token and emails
// the prospect/guardian. Until consent lands the recruit stays messaging-blocked.
router.post('/recruits/:id/invite', async (req, res) => {
  try {
    const r = await Recruit.findOne({ _id: req.params.id, coach: req.user._id });
    if (!r) return res.status(404).json({ error: 'Recruit not found' });
    const toEmail = req.body?.email || r.email;
    if (!toEmail) return res.status(400).json({ error: 'A recipient email is required to send a consent invite.' });
    r.inviteToken = crypto.randomBytes(24).toString('hex');
    r.consentStatus = 'invited';
    if (req.body?.email) r.email = req.body.email;
    await r.save();

    const base = (process.env.APP_URL || process.env.BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    const link = `${base}/consent/${r.inviteToken}`;
    await sendEmail({
      to: toEmail,
      subject: `${req.user.name} (${req.user.program || 'a college program'}) wants to connect`,
      html: `<div style="font-family:system-ui,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px">
        <h2 style="margin:0 0 8px">A coach wants to connect</h2>
        <p style="color:#555;font-size:14px;line-height:1.6">${r.isMinor ? 'A parent/guardian must review and consent before any contact.' : 'Review and confirm to allow the coach to reach out.'} This keeps recruiting transparent and NCAA-compliant.</p>
        <p style="margin:24px 0"><a href="${link}" style="background:#1E1E1E;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;font-size:14px">Review &amp; respond →</a></p>
        <p style="color:#999;font-size:12px">${link}</p>
      </div>`
    });
    await log({ recruit: r._id, coach: req.user._id, athlete: r.athlete, kind: 'invite', initiatedBy: 'coach', channel: 'email', allowed: true, periodType: 'exempt', body: `Consent invite sent to ${toEmail}` });
    res.json({ ok: true, consentStatus: r.consentStatus });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Calendar + consent-gated outreach. The core NCAA enforcement point.
router.post('/recruits/:id/message', requireCap('recruitMessaging', 'Recruit messaging'), async (req, res) => {
  try {
    const r = await Recruit.findOne({ _id: req.params.id, coach: req.user._id });
    if (!r) return res.status(404).json({ error: 'Recruit not found' });
    const { body } = req.body || {};
    if (!body) return res.status(400).json({ error: 'Message body required' });

    // 1) Consent gate. Minors need guardian consent; adults need athlete consent.
    if (!r.consentAllowsMessaging()) {
      await log({ recruit: r._id, coach: req.user._id, athlete: r.athlete, kind: 'blocked_attempt', initiatedBy: 'coach', allowed: false, periodType: 'consent', blockReason: 'No valid consent on file', body: '(blocked) ' + String(body).slice(0, 500) });
      return res.status(403).json({
        error: r.isMinor ? 'A guardian must consent before you can message this recruit.' : 'This recruit has not consented to contact yet.',
        needsConsent: true, isMinor: r.isMinor, consentStatus: r.consentStatus
      });
    }

    // 2) Calendar gate (coach-initiated only).
    const verdict = await evaluateAction({ sport: r.sport, division: r.division, action: 'message' });
    if (!verdict.allowed) {
      await log({ recruit: r._id, coach: req.user._id, athlete: r.athlete, kind: 'blocked_attempt', initiatedBy: 'coach', allowed: false, periodType: verdict.periodType, blockReason: verdict.reason, body: '(blocked) ' + String(body).slice(0, 500) });
      await sendViolationAlert({ coach: req.user, recruit: r, action: 'message', verdict }).catch(() => {});
      return res.status(409).json({ error: verdict.reason, period: verdict.periodType, nextAllowedAt: verdict.nextAllowedAt, blocked: true });
    }

    // Permitted → deliver (in-app activity if linked + email if we have one) + log.
    if (r.athlete) await Activity.create({ user: r.athlete, type: 'deal_offer', title: `Message from Coach ${req.user.name}`, message: String(body).slice(0, 300) }).catch(() => {});
    if (r.email) await sendEmail({ to: r.email, subject: `Message from ${req.user.name}${req.user.program ? ` — ${req.user.program}` : ''}`, html: `<p>${String(body).replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>` }).catch(() => {});
    r.lastContactedAt = new Date();
    if (r.stage === 'prospect') r.stage = 'contacted';
    await r.save();
    const entry = await log({ recruit: r._id, coach: req.user._id, athlete: r.athlete, kind: 'message', initiatedBy: 'coach', channel: r.email ? 'email' : 'in_app', allowed: true, periodType: verdict.periodType, body: String(body).slice(0, 2000) });
    res.json({ ok: true, entry, period: verdict.periodType });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Schedule a visit — gated by the visitScheduling cap AND the calendar (visits are
// disallowed in evaluation/quiet/dead periods).
router.post('/recruits/:id/visit', requireCap('visitScheduling', 'Visit scheduling'), async (req, res) => {
  try {
    const r = await Recruit.findOne({ _id: req.params.id, coach: req.user._id });
    if (!r) return res.status(404).json({ error: 'Recruit not found' });
    if (!r.consentAllowsMessaging()) return res.status(403).json({ error: 'Consent is required before scheduling a visit.', needsConsent: true });
    const { date, kind } = req.body || {};

    const verdict = await evaluateAction({ sport: r.sport, division: r.division, action: 'visit' });
    if (!verdict.allowed) {
      await log({ recruit: r._id, coach: req.user._id, athlete: r.athlete, kind: 'blocked_attempt', initiatedBy: 'coach', allowed: false, periodType: verdict.periodType, blockReason: verdict.reason, body: '(blocked) visit' });
      await sendViolationAlert({ coach: req.user, recruit: r, action: 'visit', verdict }).catch(() => {});
      return res.status(409).json({ error: verdict.reason, period: verdict.periodType, nextAllowedAt: verdict.nextAllowedAt, blocked: true });
    }
    r.stage = 'visit_scheduled';
    await r.save();
    const entry = await log({ recruit: r._id, coach: req.user._id, athlete: r.athlete, kind: 'visit_scheduled', initiatedBy: 'coach', channel: 'visit', allowed: true, periodType: verdict.periodType, body: `${kind || 'Visit'} scheduled${date ? ` for ${date}` : ''}` });
    if (r.athlete) await Activity.create({ user: r.athlete, type: 'deal_offer', title: 'Visit scheduled', message: `${req.user.program || req.user.name} scheduled a ${kind || 'visit'}` }).catch(() => {});
    res.json({ ok: true, entry });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Trigger a compliance digest email to the coach's compliance officer.
router.post('/compliance/digest', async (req, res) => {
  try {
    const { status, rows } = await sendContactDigest({ coach: req.user, limit: 50 });
    res.json({ ok: true, emailStatus: status, count: rows.length, configured: !!req.user.complianceOfficerEmail });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Compliance export (Program+). CSV of the full contact log.
router.get('/compliance/export', requireCap('complianceExport', 'Compliance export'), async (req, res) => {
  try {
    const rows = await ContactLog.find({ coach: req.user._id }).populate('recruit', 'name').sort({ createdAt: -1 }).lean();
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const header = 'timestamp,recruit,kind,initiatedBy,channel,period,allowed,blockReason,body';
    const lines = rows.map(r => [new Date(r.createdAt).toISOString(), r.recruit?.name || '', r.kind, r.initiatedBy, r.channel, r.periodType, r.allowed, r.blockReason, r.body].map(esc).join(','));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="compliance-log.csv"');
    res.send([header, ...lines].join('\n'));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Request program verification: the coach submits an institutional email; if the
// domain qualifies we email a single-use confirm link. Clicking it flips the badge.
router.post('/verify', async (req, res) => {
  try {
    if (req.user.verifiedProgram) return res.json({ ok: true, alreadyVerified: true });
    const institutionalEmail = String(req.body?.institutionalEmail || '').toLowerCase().trim();
    if (!institutionalEmail) return res.status(400).json({ error: 'An institutional email is required.' });
    if (!isInstitutionalEmail(institutionalEmail)) {
      return res.status(400).json({ error: 'Use a school-issued email (e.g. an .edu address) so we can verify your program. Contact support if your program uses another domain.' });
    }
    const token = crypto.randomBytes(24).toString('hex');
    req.user.institutionalEmail = institutionalEmail;
    req.user.programVerifyToken = token;
    await req.user.save();

    const base = (process.env.APP_URL || process.env.BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    const link = `${base}/api/coaches/verify/${token}`;
    const { status } = await sendEmail({
      to: institutionalEmail,
      subject: 'Verify your program on Digital NIL',
      html: `<div style="font-family:system-ui,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px">
        <h2 style="margin:0 0 8px">Verify your program</h2>
        <p style="color:#555;font-size:14px;line-height:1.6">Confirm you're staff at ${esc(req.user.program || 'your program')} to earn the verified badge that athletes look for.</p>
        <p style="margin:24px 0"><a href="${link}" style="background:#1E1E1E;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;font-size:14px">Verify my program →</a></p>
        <p style="color:#999;font-size:12px">${link}</p>
      </div>`
    });
    res.json({ ok: true, sentTo: institutionalEmail, emailStatus: status });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Coach profile enrichment (scrape → confirm). Reuses the headshot resolver and
// YouTube reel finder; scraped fields land in profileSources as 'unverified' for
// the coach to confirm. Input data is never overwritten.
router.post('/profile/enrich', async (req, res) => {
  try {
    const { enrichCoachProfile } = await import('../lib/coachEnrichment.js');
    const result = await enrichCoachProfile(req.user);
    res.json({ ok: true, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
