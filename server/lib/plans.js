// Canonical subscription tiers for EVERY role — single source of truth for pricing,
// limits, and feature capabilities. Each role (brand / athlete / agent) has its own
// ladder; a user's chosen tier is stored on `User.plan` and gates what they can do.
//
// Tiers govern access + volume; the platform service fee governs deal economics.
// The fee on a closed deal is set by the REPRESENTING AGENT's tier (`dealFeeRate`):
// the higher the agent's plan, the smaller the cut the platform keeps — "upgrade to
// keep more of every deal". Deals with no agent fall back to DEFAULT_FEE_RATE.
//
// MIRRORED in client/index.html (const PLANS_BY_ROLE) — keep the two in sync.
// `Infinity` limit = unlimited. Tiers are ordered cheapest→priciest by `order`.
// Prices are USD per month (athlete/agent) or per month (brand); 0 = free forever.

// Fair-market rework (2026, v2 — competitive deep dive): every billable role has a
// Free tier + exactly FOUR paid tiers. Prices are USD/month; `annual` is the USD/year
// price (2 months free ≈ 17% off). Capability keys gate features via planCan(); limit
// keys gate volume via planLimit(). Keep keys stable across repricings so a user's
// stored `User.plan` never orphans. See PRICING.md for the rationale + benchmarks.
//
// Two-sided pricing principle: athletes ARE the inventory on the NIL side, so we keep
// them cheap there and charge demand (brands/agents); on the RECRUITING side coaches
// are scarce, so athletes pay to reach them. Brand/coach ceilings are "custom"
// Enterprise numbers — the market pays $2.5k–5k/mo (MarketPryce, Opendorse, conferences).
const brand = [
  {
    key: 'free', name: 'Free', price: 0, order: 0, tagline: 'Explore the marketplace',
    limits: { deals: 1, campaigns: 0, contacts: 3, seats: 1 },
    caps: { directOffers: false, analytics: false, fmvAnalytics: false, bulkOutreach: false, recruitmentTrips: false, prioritySupport: false, accountManager: false, whiteLabel: false, api: false, sso: false },
    features: ['Browse the full athlete directory', 'View media kits & highlights', '1 active deal listing at a time', '3 athlete contacts / month', 'Receive athlete applications'],
  },
  {
    key: 'starter', name: 'Starter', price: 99, annual: 990, order: 1, tagline: 'Start signing athletes',
    limits: { deals: 5, campaigns: 3, contacts: 25, seats: 2 },
    caps: { directOffers: true, analytics: false, fmvAnalytics: false, bulkOutreach: false, recruitmentTrips: false, prioritySupport: false, accountManager: false, whiteLabel: false, api: false, sso: false },
    features: ['Everything in Free, plus:', 'Send direct offers to any athlete', 'Up to 5 active deals & 3 campaigns', '25 athlete contacts / month', '2 team seats'],
  },
  {
    key: 'growth', name: 'Growth', price: 299, annual: 2990, order: 2, tagline: 'Scale your NIL program', popular: true,
    limits: { deals: 25, campaigns: 10, contacts: 100, seats: 5 },
    caps: { directOffers: true, analytics: true, fmvAnalytics: true, bulkOutreach: false, recruitmentTrips: false, prioritySupport: false, accountManager: false, whiteLabel: false, api: false, sso: false },
    features: ['Everything in Starter, plus:', 'Up to 25 active deals & 10 campaigns', '100 athlete contacts / month', 'Fair-market-value & audience analytics', '5 team seats'],
  },
  {
    key: 'pro', name: 'Pro', price: 799, annual: 7990, order: 3, tagline: 'Unlimited deal flow',
    limits: { deals: Infinity, campaigns: Infinity, contacts: Infinity, seats: 10 },
    caps: { directOffers: true, analytics: true, fmvAnalytics: true, bulkOutreach: true, recruitmentTrips: false, prioritySupport: true, accountManager: false, whiteLabel: false, api: false, sso: false },
    features: ['Everything in Growth, plus:', 'Unlimited deals, campaigns & contacts', 'Bulk athlete outreach', 'ROI & performance analytics', '10 team seats', 'Priority support'],
  },
  {
    key: 'elite', name: 'Enterprise', price: 2500, annual: 25000, order: 4, tagline: 'Custom — full platform + recruitment trips', custom: true,
    limits: { deals: Infinity, campaigns: Infinity, contacts: Infinity, seats: Infinity },
    caps: { directOffers: true, analytics: true, fmvAnalytics: true, bulkOutreach: true, recruitmentTrips: true, prioritySupport: true, accountManager: true, whiteLabel: true, api: true, sso: true },
    features: ['Everything in Pro, plus:', 'Funded recruitment-trip deals', 'White-label, API & SSO', 'Unlimited seats', 'Dedicated account manager', 'White-glove onboarding'],
  },
];

// Athlete: cheap on the NIL side (they are the inventory), monetized on the RECRUITING
// side (coaches are scarce — this is the NCSA $1,500–4,200 willingness-to-pay). `starter`
// is the recruiting unlock; the one-time $99 sign-up fee + exportTier kit/pack ($99/$299)
// remain a-la-carte media-kit SKUs orthogonal to this ladder. `coachContacts` limits
// free-tier intro requests; paid tiers open unlimited messaging via contactCoach.
const athlete = [
  {
    key: 'free', name: 'Free', price: 0, order: 0, tagline: 'Get discovered',
    limits: { mediaKitItems: 3, coachContacts: 3 },
    caps: { contactCoach: false, mediaKitPdf: false, analytics: false, featuredBoost: false, outreach: false, prioritySupport: false },
    features: ['Public athlete profile & highlight reel', 'Apply to open deals', 'Browse the coach & program directory', 'Share-card (PNG) export', '3 coach intro requests / month', 'Up to 3 media-kit items'],
  },
  {
    key: 'starter', name: 'Recruit', price: 19, annual: 190, order: 1, tagline: 'Reach out to programs',
    limits: { mediaKitItems: 10, coachContacts: Infinity },
    caps: { contactCoach: true, mediaKitPdf: false, analytics: false, featuredBoost: false, outreach: false, prioritySupport: false },
    features: ['Everything in Free, plus:', 'Unlimited coach messaging & interest', 'Advanced school search & filters', 'Who-viewed-me + recruiting checklist', 'Up to 10 media-kit items'],
  },
  {
    key: 'plus', name: 'Spotlight', price: 39, annual: 390, order: 2, tagline: 'Stand out to brands', popular: true,
    limits: { mediaKitItems: Infinity, coachContacts: Infinity },
    caps: { contactCoach: true, mediaKitPdf: true, analytics: true, featuredBoost: false, outreach: false, prioritySupport: false },
    features: ['Everything in Recruit, plus:', 'High-end media-kit PDF export', 'Brand-deal marketplace access', 'Unlimited media-kit items', 'Profile & reach analytics'],
  },
  {
    key: 'pro', name: 'Pro', price: 79, annual: 790, order: 3, tagline: 'Maximize your NIL',
    limits: { mediaKitItems: Infinity, coachContacts: Infinity },
    caps: { contactCoach: true, mediaKitPdf: true, analytics: true, featuredBoost: true, outreach: true, prioritySupport: false },
    features: ['Everything in Spotlight, plus:', 'Featured placement in Discover', 'AI-assisted outreach to brands & programs', 'Verified badge & priority visibility'],
  },
  {
    key: 'elite', name: 'Elite', price: 149, annual: 1490, order: 4, tagline: 'Concierge NIL + recruiting',
    limits: { mediaKitItems: Infinity, coachContacts: Infinity },
    caps: { contactCoach: true, mediaKitPdf: true, analytics: true, featuredBoost: true, outreach: true, prioritySupport: true },
    features: ['Everything in Pro, plus:', 'Top placement across Discover & coach search', 'Concierge media-kit production', 'Human-assisted recruiting outreach', 'Priority support'],
  },
];

// Agent: the take-rate is the real revenue engine, not the base fee. Rake declines
// with tier (20%→4%) so high-GMV agencies stay — at scale, 4% vs 8% of GMV dwarfs the
// subscription. Tiers also cap roster size + billable seats. Agencies live at 10–20%
// commission, so a free 20% / paid 15→4% ladder is competitive.
const agent = [
  {
    key: 'free', name: 'Free', price: 0, order: 0, tagline: 'Manage a small roster',
    limits: { roster: 3, seats: 1 },
    dealFeeRate: 0.20,
    caps: { outreachEmail: false, analytics: false, clientPortal: false, prioritySupport: false, whiteLabel: false, api: false, sso: false },
    features: ['Up to 3 roster athletes', 'CRM: leads, pipeline & accounts', 'Build & broker deals', 'Media-kit tools', '20% platform fee on closed deals'],
  },
  {
    key: 'starter', name: 'Starter', price: 99, annual: 990, order: 1, tagline: 'Grow your book',
    limits: { roster: 15, seats: 1 },
    dealFeeRate: 0.15,
    caps: { outreachEmail: false, analytics: false, clientPortal: false, prioritySupport: false, whiteLabel: false, api: false, sso: false },
    features: ['Everything in Free, plus:', 'Up to 15 roster athletes', 'Talent marketing tools', 'Bulk media-kit export', 'Reduced 15% platform fee'],
  },
  {
    key: 'pro', name: 'Pro', price: 299, annual: 2990, order: 2, tagline: 'Run a full agency', popular: true,
    limits: { roster: 50, seats: 3 },
    dealFeeRate: 0.10,
    caps: { outreachEmail: true, analytics: true, clientPortal: true, prioritySupport: false, whiteLabel: false, api: false, sso: false },
    features: ['Everything in Starter, plus:', 'Up to 50 roster athletes', '3 agency seats', 'CRM outreach email (Resend)', 'Branded client portal', 'Reduced 10% platform fee'],
  },
  {
    key: 'agency', name: 'Agency', price: 699, annual: 6990, order: 3, tagline: 'Scale your agency',
    limits: { roster: 200, seats: 10 },
    dealFeeRate: 0.07,
    caps: { outreachEmail: true, analytics: true, clientPortal: true, prioritySupport: true, whiteLabel: true, api: false, sso: false },
    features: ['Everything in Pro, plus:', 'Up to 200 roster athletes', '10 agency seats', 'Reduced 7% platform fee', 'White-label media kits', 'Priority support'],
  },
  {
    key: 'enterprise', name: 'Enterprise', price: 1499, annual: 14990, order: 4, tagline: 'Unlimited scale', custom: true,
    limits: { roster: Infinity, seats: Infinity },
    dealFeeRate: 0.04,
    caps: { outreachEmail: true, analytics: true, clientPortal: true, prioritySupport: true, whiteLabel: true, api: true, sso: true },
    features: ['Everything in Agency, plus:', 'Unlimited roster & seats', 'Lowest 4% platform fee', 'Dedicated account team', 'API, SSO & custom integrations'],
  },
];

// Coaches (NCAA recruiting-only, no representation / no deal fees). Tiers gate the
// recruiting funnel: roster size of active recruits, messaging, visit scheduling,
// compliance export and multi-coach seats. Free is calendar-view + tracking only.
const coach = [
  {
    key: 'free', name: 'Free', price: 0, order: 0, tagline: 'Track a few recruits',
    limits: { recruits: 5, seats: 1 },
    caps: { recruitMessaging: false, visitScheduling: false, complianceExport: false, multiSeat: false, analytics: false, prioritySupport: false, whiteLabel: false },
    features: ['Up to 5 tracked recruits', 'Live NCAA recruiting-calendar view', 'Transparent contact log', 'Receive athlete-initiated interest'],
  },
  {
    key: 'recruiter', name: 'Recruiter', price: 99, annual: 990, order: 1, tagline: 'Work your board',
    limits: { recruits: 50, seats: 1 },
    caps: { recruitMessaging: true, visitScheduling: false, complianceExport: false, multiSeat: false, analytics: false, prioritySupport: false, whiteLabel: false },
    features: ['Everything in Free, plus:', 'Up to 50 recruits', 'Calendar-gated recruit messaging', 'Saved searches, pipeline stages & lead scoring'],
  },
  {
    key: 'program', name: 'Program', price: 299, annual: 2990, order: 2, tagline: 'Run a program', popular: true,
    limits: { recruits: 250, seats: 3 },
    caps: { recruitMessaging: true, visitScheduling: true, complianceExport: true, multiSeat: true, analytics: true, prioritySupport: false, whiteLabel: false },
    features: ['Everything in Recruiter, plus:', 'Up to 250 recruits', '3 coach seats', 'Official/unofficial visit scheduling', 'Compliance log export (PDF/CSV)', 'Recruiting analytics'],
  },
  {
    key: 'department', name: 'Department', price: 699, annual: 6990, order: 3, tagline: 'Whole department',
    limits: { recruits: Infinity, seats: 10 },
    caps: { recruitMessaging: true, visitScheduling: true, complianceExport: true, multiSeat: true, analytics: true, prioritySupport: false, whiteLabel: false },
    features: ['Everything in Program, plus:', 'Unlimited recruits', 'Multi-coach seats (up to 10)', 'Multi-sport & advanced analytics', 'Integrations'],
  },
  {
    key: 'conference', name: 'Conference', price: 1999, annual: 19990, order: 4, tagline: 'Custom — conference-grade', custom: true,
    limits: { recruits: Infinity, seats: Infinity },
    caps: { recruitMessaging: true, visitScheduling: true, complianceExport: true, multiSeat: true, analytics: true, prioritySupport: true, whiteLabel: true },
    features: ['Everything in Department, plus:', 'Unlimited coach seats', 'Dedicated compliance dashboard', 'White-label, SSO & multi-program', 'Priority support'],
  },
];

export const PLANS_BY_ROLE = { brand, athlete, agent, coach };

// Roles that have a subscription ladder (admins are unbilled staff).
export const BILLABLE_ROLES = Object.keys(PLANS_BY_ROLE);

export const plansForRole = (role) => PLANS_BY_ROLE[role] || [];

// Resolve a plan object from a role + plan key, falling back to the role's free tier.
export const planFor = (role, key) => {
  const list = plansForRole(role);
  return list.find(p => p.key === key) || list[0] || null;
};
export const planOf = (user) => (user ? planFor(user.role, user.plan) : null);

export const planKeysForRole = (role) => plansForRole(role).map(p => p.key);
export const isValidPlan = (role, key) => planKeysForRole(role).includes(key);
export const isPaidPlan = (role, key) => {
  const p = planFor(role, key);
  return !!p && p.price > 0;
};

// Limit/capability lookups. Unknown limit → Infinity (ungated); unknown cap → false.
export const planLimit = (user, key) => {
  const p = planOf(user);
  const v = p && p.limits ? p.limits[key] : undefined;
  return v === undefined ? Infinity : v;
};
export const planCan = (user, cap) => {
  const p = planOf(user);
  return !!(p && p.caps && p.caps[cap]);
};

// Platform deal fee when no tiered rate applies (e.g. a deal with no agent).
export const DEFAULT_FEE_RATE = 0.20;

// The platform fee rate for a user's plan (agents lower it by tier). Falls back to
// the default when the plan doesn't define one. Pass the REPRESENTING AGENT.
export const planFeeRate = (user) => {
  const p = planOf(user);
  return p && typeof p.dealFeeRate === 'number' ? p.dealFeeRate : DEFAULT_FEE_RATE;
};

// Cheapest tier in a role that unlocks a capability — used to word upgrade prompts.
export const minPlanForCap = (role, cap) => plansForRole(role).find(p => p.caps && p.caps[cap]) || null;
export const minPlanForLimit = (role, key, needed) =>
  plansForRole(role).find(p => (p.limits?.[key] ?? Infinity) >= needed) || null;

// Client-safe serialization: Infinity isn't valid JSON, so map unlimited → null.
export const serializePlans = () => {
  const enc = (list) => list.map(p => ({
    ...p,
    limits: Object.fromEntries(Object.entries(p.limits || {}).map(([k, v]) => [k, v === Infinity ? null : v])),
  }));
  return Object.fromEntries(Object.entries(PLANS_BY_ROLE).map(([role, list]) => [role, enc(list)]));
};
