# Digital NIL — Pricing & Tier Rationale (2026 v2)

Single source of truth for prices/limits/caps is [`server/lib/plans.js`](server/lib/plans.js); the
client mirror is `const PLANS_BY_ROLE` in [`client/index.html`](client/index.html). Keep the two in sync.
Every billable role has **Free + exactly 4 paid tiers**. `annual` ≈ 2 months free (~17% off).

## Pricing principle (two-sided marketplace)
The platform has two sides with opposite scarcity:

- **NIL side** — athletes *are* the inventory. Keep them cheap; charge the demand side (brands & agents).
- **Recruiting side** — coaches are scarce and the prize. Athletes pay to reach them (the NCSA
  willingness-to-pay is ~$1,500–4,200 over a recruiting cycle). Coaches/programs pay institutional rates.

Brand and coach ceilings are "Custom" Enterprise numbers — the comparable market (Opendorse, MarketPryce,
conference deals) transacts at roughly **$2.5k–5k/mo**.

## Brand (demand side — NIL)
| Tier | Price/mo | Annual | Highlights |
|---|---|---|---|
| Free | $0 | — | Browse directory, 1 deal, 3 contacts/mo |
| Starter | $99 | $990 | Direct offers, 5 deals, 25 contacts, 2 seats |
| Growth ★ | $299 | $2,990 | 25 deals, FMV + audience analytics, 5 seats |
| Pro | $799 | $7,990 | Unlimited deals/contacts, bulk outreach, 10 seats |
| Enterprise | $2,500 (custom) | $25,000 | Recruitment trips, white-label, API, SSO, unlimited seats |

## Athlete (supply side — cheap; recruiting unlock is the upsell)
| Tier | Price/mo | Annual | Highlights |
|---|---|---|---|
| Free | $0 | — | Profile, apply to deals, browse coaches, 3 coach intros/mo |
| Recruit | $19 | $190 | Unlimited coach messaging, school search, who-viewed-me |
| Spotlight ★ | $39 | $390 | Media-kit PDF, brand marketplace, analytics |
| Pro | $79 | $790 | Featured placement, AI outreach, verified badge |
| Elite | $149 | $1,490 | Top placement, concierge media kit, human outreach |

The one-time **$99 sign-up fee** and **exportTier** kit/pack ($99/$299) media-kit SKUs are a-la-carte and
orthogonal to this subscription ladder.

## Agent (take-rate is the engine)
Subscription is secondary; the declining **platform fee** (rake) keeps high-GMV agencies on-platform.
| Tier | Price/mo | Annual | Roster | Fee |
|---|---|---|---|---|
| Free | $0 | — | 3 | 20% |
| Starter | $99 | $990 | 15 | 15% |
| Pro ★ | $299 | $2,990 | 50 | 10% |
| Agency | $699 | $6,990 | 200 | 7% |
| Enterprise | $1,499 (custom) | $14,990 | ∞ | 4% |

## Coach (NCAA recruiting-only — no representation, no deal fees)
Tiers gate the compliant recruiting funnel: tracked recruits, calendar-gated messaging, visit scheduling,
compliance export, and multi-coach seats. Free is **calendar-view + tracking only** (no messaging).
| Tier | Price/mo | Annual | Recruits | Unlocks |
|---|---|---|---|---|
| Free | $0 | — | 5 | Calendar view, contact log, inbound interest |
| Recruiter | $99 | $990 | 50 | Calendar-gated messaging, pipeline, scoring |
| Program ★ | $299 | $2,990 | 250 | Visit scheduling, compliance export, analytics, 3 seats |
| Department | $699 | $6,990 | ∞ | Unlimited recruits, 10 seats, multi-sport analytics |
| Conference | $1,999 (custom) | $19,990 | ∞ | Unlimited seats, compliance dashboard, white-label, SSO |

## Compliance model (coach ↔ recruit)
- **Athlete-initiated** interest is calendar-**exempt** (a prospect may contact a coach anytime) and implies consent.
- **Coach-initiated** messaging/visits are gated by the **NCAA recruiting calendar** (Contact / Evaluation /
  Quiet / Dead) per sport + division — see [`server/lib/recruiting.js`](server/lib/recruiting.js).
- **Minors** require **guardian consent** before any coach messaging; off-platform prospects require
  **invite → register → consent** first.
- Every interaction is written to an immutable **ContactLog** visible to athlete, coach and compliance; the
  coach's `complianceOfficerEmail` receives violation alerts + on-demand digests.
- The recruiting calendar is **admin-editable** (`/api/admin/recruiting-periods`) since NCAA windows change yearly.
