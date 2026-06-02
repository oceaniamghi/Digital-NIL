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

const brand = [
  {
    key: 'free', name: 'Free', price: 0, order: 0, tagline: 'Explore the marketplace',
    limits: { deals: 1, campaigns: 0 },
    caps: { directOffers: false, analytics: false, recruitmentTrips: false, prioritySupport: false, accountManager: false },
    features: ['Browse the full athlete directory', 'View media kits & highlights', '1 active deal listing at a time', 'Receive athlete applications'],
  },
  {
    key: 'starter', name: 'Starter', price: 1000, order: 1, tagline: 'Start signing athletes',
    limits: { deals: 5, campaigns: 1 },
    caps: { directOffers: true, analytics: false, recruitmentTrips: false, prioritySupport: false, accountManager: false },
    features: ['Everything in Free, plus:', 'Send direct offers to any athlete', 'Up to 5 active deals', '1 active campaign'],
  },
  {
    key: 'growth', name: 'Growth', price: 2500, order: 2, tagline: 'Scale your NIL program', popular: true,
    limits: { deals: 25, campaigns: 10 },
    caps: { directOffers: true, analytics: true, recruitmentTrips: false, prioritySupport: false, accountManager: false },
    features: ['Everything in Starter, plus:', 'Up to 25 active deals', 'Up to 10 campaigns', 'Performance analytics & insights'],
  },
  {
    key: 'pro', name: 'Pro', price: 5000, order: 3, tagline: 'Unlimited deal flow',
    limits: { deals: Infinity, campaigns: Infinity },
    caps: { directOffers: true, analytics: true, recruitmentTrips: false, prioritySupport: true, accountManager: false },
    features: ['Everything in Growth, plus:', 'Unlimited active deals', 'Unlimited campaigns', 'Priority athlete placement', 'Priority support'],
  },
  {
    key: 'elite', name: 'Elite', price: 10000, order: 4, tagline: 'Full platform + recruitment trips',
    limits: { deals: Infinity, campaigns: Infinity },
    caps: { directOffers: true, analytics: true, recruitmentTrips: true, prioritySupport: true, accountManager: true },
    features: ['Everything in Pro, plus:', 'Full access to every Digital NIL tool', 'Deals with funded recruitment trips', 'Dedicated account manager', 'White-glove onboarding'],
  },
];

const athlete = [
  {
    key: 'free', name: 'Free', price: 0, order: 0, tagline: 'Get discovered',
    limits: { mediaKitItems: 3 },
    caps: { mediaKitPdf: false, analytics: false, featuredBoost: false, outreach: false, prioritySupport: false },
    features: ['Public athlete profile & highlight reel', 'Apply to open deals', 'Share-card (PNG) export', 'Up to 3 media-kit items'],
  },
  {
    key: 'plus', name: 'Plus', price: 19, order: 1, tagline: 'Stand out to brands', popular: true,
    limits: { mediaKitItems: Infinity },
    caps: { mediaKitPdf: true, analytics: true, featuredBoost: false, outreach: false, prioritySupport: false },
    features: ['Everything in Free, plus:', 'High-end media-kit PDF export', 'Unlimited media-kit items', 'Profile & reach analytics'],
  },
  {
    key: 'pro', name: 'Pro', price: 49, order: 2, tagline: 'Maximize your NIL',
    limits: { mediaKitItems: Infinity },
    caps: { mediaKitPdf: true, analytics: true, featuredBoost: true, outreach: true, prioritySupport: true },
    features: ['Everything in Plus, plus:', 'Featured placement in Discover', 'Direct outreach to brands & programs', 'Priority support'],
  },
];

const agent = [
  {
    key: 'free', name: 'Free', price: 0, order: 0, tagline: 'Manage a small roster',
    limits: { roster: 3 },
    dealFeeRate: 0.20,
    caps: { outreachEmail: false, analytics: false, prioritySupport: false, whiteLabel: false },
    features: ['Up to 3 roster athletes', 'CRM: leads, pipeline & accounts', 'Build & broker deals', 'Media-kit tools', '20% platform fee on closed deals'],
  },
  {
    key: 'starter', name: 'Starter', price: 99, order: 1, tagline: 'Grow your book',
    limits: { roster: 15 },
    dealFeeRate: 0.15,
    caps: { outreachEmail: false, analytics: false, prioritySupport: false, whiteLabel: false },
    features: ['Everything in Free, plus:', 'Up to 15 roster athletes', 'Talent marketing tools', 'Bulk media-kit export', 'Reduced 15% platform fee'],
  },
  {
    key: 'pro', name: 'Pro', price: 299, order: 2, tagline: 'Run a full agency', popular: true,
    limits: { roster: 60 },
    dealFeeRate: 0.10,
    caps: { outreachEmail: true, analytics: true, prioritySupport: false, whiteLabel: false },
    features: ['Everything in Starter, plus:', 'Up to 60 roster athletes', 'CRM outreach email (Resend)', 'Agency analytics & reporting', 'Reduced 10% platform fee'],
  },
  {
    key: 'agency', name: 'Agency', price: 799, order: 3, tagline: 'Unlimited scale',
    limits: { roster: Infinity },
    dealFeeRate: 0.05,
    caps: { outreachEmail: true, analytics: true, prioritySupport: true, whiteLabel: true },
    features: ['Everything in Pro, plus:', 'Unlimited roster athletes', 'Lowest 5% platform fee', 'White-glove onboarding', 'Priority support', 'White-label media kits'],
  },
];

export const PLANS_BY_ROLE = { brand, athlete, agent };

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
