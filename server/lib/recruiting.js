import RecruitingPeriod, { PERIOD_TYPES } from '../models/RecruitingPeriod.js';

// ── NCAA recruiting-calendar engine ──────────────────────────────────────────
// Resolves the active period for a sport/division on a date and decides whether a
// given coach-initiated action is permissible. Rules summarized from the NCAA
// recruiting calendar (https://www.ncsasports.org/ncaa-eligibility-center/
// recruiting-rules/recruiting-calendar). Coaches CANNOT relax these — the gate is
// enforced server-side in routes/coaches.js and every attempt is logged.

// What each period permits for COACH-INITIATED actions. (Athlete-initiated contact
// is always allowed and bypasses this matrix — handled by the caller.)
//   message → off-campus electronic/voice contact with the recruit
//   visit   → scheduling an official/unofficial in-person visit
//   evaluate→ assessing the prospect's ability (always allowed except in dead)
const ACTION_MATRIX = {
  contact:    { message: true,  visit: true,  evaluate: true },
  evaluation: { message: false, visit: false, evaluate: true },
  quiet:      { message: true,  visit: false, evaluate: false },  // message allowed but only on-campus visits (no scheduling off-campus)
  dead:       { message: false, visit: false, evaluate: false },
  // No period on the calendar → treat as the most permissive "open" window, but
  // still log it so compliance can spot gaps in the calendar data.
  none:       { message: true,  visit: true,  evaluate: true },
};

export { PERIOD_TYPES };

const DAY = 86400000;

// The active period doc for a sport/division on `date` (latest-starting match).
export async function currentPeriod(sport, division = 'D1', date = new Date()) {
  if (!sport) return null;
  const docs = await RecruitingPeriod.find({
    sport: new RegExp(`^${escapeRx(sport)}$`, 'i'),
    division: division || 'D1',
    active: true,
    startDate: { $lte: date },
    endDate: { $gte: date }
  }).sort({ startDate: -1 }).limit(1);
  return docs[0] || null;
}

// The next period that STARTS after `date` (used to tell a coach when an action
// becomes permissible).
export async function nextPeriod(sport, division = 'D1', date = new Date()) {
  if (!sport) return null;
  const docs = await RecruitingPeriod.find({
    sport: new RegExp(`^${escapeRx(sport)}$`, 'i'),
    division: division || 'D1',
    active: true,
    startDate: { $gt: date }
  }).sort({ startDate: 1 }).limit(1);
  return docs[0] || null;
}

// Decide whether a coach-initiated `action` ('message'|'visit'|'evaluate') is
// allowed right now for a sport/division. Returns a structured verdict that the
// route turns into either a success path or a 409 + ContactLog blocked_attempt.
export async function evaluateAction({ sport, division = 'D1', action, date = new Date() }) {
  const period = await currentPeriod(sport, division, date);
  const type = period ? period.type : 'none';
  const matrix = ACTION_MATRIX[type] || ACTION_MATRIX.none;
  const allowed = matrix[action] !== false;

  let nextAllowedAt = null;
  if (!allowed) {
    // Find the soonest upcoming period that permits this action.
    const upcoming = await RecruitingPeriod.find({
      sport: new RegExp(`^${escapeRx(sport)}$`, 'i'),
      division: division || 'D1', active: true, startDate: { $gt: date }
    }).sort({ startDate: 1 }).limit(8);
    const ok = upcoming.find(p => (ACTION_MATRIX[p.type] || {})[action] !== false);
    nextAllowedAt = ok ? ok.startDate : null;
  }

  return {
    allowed,
    periodType: type,
    periodLabel: period ? (period.label || type) : 'No calendar window on file',
    period,
    nextAllowedAt,
    reason: allowed ? '' : reasonFor(type, action, nextAllowedAt)
  };
}

function reasonFor(type, action, nextAllowedAt) {
  const verb = action === 'message' ? 'contacting recruits' : action === 'visit' ? 'scheduling in-person visits' : 'evaluating recruits';
  const when = nextAllowedAt ? ` It will be permitted from ${new Date(nextAllowedAt).toISOString().slice(0, 10)}.` : '';
  const label = { dead: 'a Dead Period', evaluation: 'an Evaluation Period', quiet: 'a Quiet Period', contact: 'a Contact Period' }[type] || 'this period';
  return `NCAA rules prohibit ${verb} during ${label}.${when}`;
}

function escapeRx(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ── Default seed calendar ─────────────────────────────────────────────────────
// A representative current-year Football (D1) calendar so the gate is meaningful
// out of the box. Admins edit/replace these per sport, division and year via the
// console. Dates are illustrative; keep them current via the admin editor.
export function defaultPeriods(year = new Date().getFullYear()) {
  const d = (m, day) => new Date(Date.UTC(year, m - 1, day));
  const mk = (type, label, sm, sd, em, ed) => ({
    sport: 'Football', division: 'D1', type, label,
    startDate: d(sm, sd), endDate: d(em, ed), year, active: true
  });
  return [
    mk('quiet',      'Winter quiet period',        1, 1, 1, 31),
    mk('contact',    'Winter contact period',      2, 1, 2, 28),
    mk('quiet',      'Spring quiet period',        3, 1, 3, 31),
    mk('evaluation', 'Spring evaluation period',   4, 15, 5, 31),
    mk('dead',       'Pre-summer dead period',     6, 1, 6, 22),
    mk('contact',    'Summer contact period',      6, 23, 7, 24),
    mk('dead',       'Late-summer dead period',    7, 25, 7, 31),
    mk('evaluation', 'Fall evaluation period',     9, 1, 11, 30),
    mk('dead',       'Holiday dead period',        12, 16, 12, 31),
  ];
}

// Idempotent seeding — only inserts when the sport/division has no periods yet.
export async function seedDefaultPeriods() {
  const existing = await RecruitingPeriod.countDocuments({ sport: 'Football', division: 'D1' });
  if (existing > 0) return 0;
  const docs = defaultPeriods();
  await RecruitingPeriod.insertMany(docs);
  return docs.length;
}
