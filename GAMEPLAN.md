# Digital NIL — Competitive Game Plan

Attack plan for the six weaknesses surfaced in the 2026 competitive deep dive. Companion to
[PRICING.md](PRICING.md). Status legend: ✅ done · 🟡 partial · ⬜ not started.

## The core insight
Liquidity is **not a feature you build — it's a motion you run.** Payments, messaging, verification,
and FMV are only worth building insofar as they make *one beachhead's loop* close. Sequence everything
against that. Our unique asset — the **agent CRM nobody else has** — is the cold-start cheat code: one
agent brings 15–50 athletes.

## Phase 0 — Beachhead & instrumentation
- **Beachhead:** one sport × one region. The codebase is football-centric (CFBD, ESPN headshots,
  NFL-draft fields) — play to it. Decision: **(A)** one Group-of-Five college conference (NIL-led,
  leans on the agent moat) vs **(B)** one state's HS football → JUCO/D2 recruiting (recruiting-led,
  undercuts NCSA). Default recommendation: **A**.
- **The only KPI that matters:** *weekly two-sided actions* — a coach→athlete contact that gets a reply,
  or a brand→athlete deal that gets **funded**. Signups are vanity; density is the game.
  → Instrumented at `GET /api/analytics/liquidity` (admin). ⬜

## Phase 1 — Rails that make the loop close
1. **Stripe Connect — real money movement** ⬜
   `Deal` already computes `gross → platformFee → athleteNet`. Wire it to rails: brand funds → escrow →
   release on `completed` → payout to athlete, platform fee + brand deal-fee retained. Add 1099/tax
   export. *Closes the biggest credibility gap vs Opendorse.*
2. **Real messaging** ⬜ — there is no `Message` model; "Inbox" is Activity-only. Build `Message` +
   threads (brand↔athlete↔agent). Coach↔recruit messaging already exists, calendar/consent-gated via
   `Recruit.consentAllowsMessaging()` + `ContactLog` — reuse that gate, don't rebuild it.
3. **Coach verification** 🟡 — `verifiedProgram` flag + admin toggle exist. Add self-serve verification:
   institutional-email-domain check + a request flow that flips the badge. → `POST /api/coaches/verify`.

## Phase 2 — Manufacture liquidity by hand (GTM, not code)
- Repurpose the unstaffed **concierge** (Athlete Elite $149 / $1,499 Signing Package) as the **seeding
  team** — solves the "concierge unstaffed" weakness and the liquidity weakness at once.
- **Agent-led supply:** hand-recruit 10–20 independent agents (free Pro 6 mo); each imports a roster.
- **Brand demand:** concierge sources 5–10 local brands, guarantees matched athletes.
- **Coaches:** hand-onboard every program in the beachhead. Density in one conference beats nationwide sparsity.
- **Gate:** do not expand verticals until the beachhead clears a density threshold (e.g. >70% of athlete
  contacts answered in 72h, ≥N funded deals/week).

## Phase 3 — Follow density
- **FMV valuation v1** ⬜ — heuristic from owned data (`followers × engagement × sport × level`),
  benchmarked against on-platform closed-deal comps (now captured by Phase 1①). Replaces the dead
  `nilValue` placeholder; feeds the `fmvAnalytics` cap. → `server/lib/valuation.js` + `GET /api/socials/fmv`.
- **Mobile = responsive PWA, not native** ⬜ — installable manifest + offline shell. Native waits until
  post-beachhead.

## How each weakness is handled
| Weakness | Treatment | Phase | Status |
|---|---|---|---|
| Liquidity (#1) | Agent-led beachhead, hand-seed both sides | 0+2 | ⬜ GTM |
| Deals don't move money | Stripe Connect on existing Deal math | 1① | ⬜ |
| No messaging | `Message` model + gated threads | 1② | ⬜ |
| No coach verification | Domain-email + self-serve badge | 1③ | 🟡 |
| No FMV | Heuristic v1 + closed-deal comps | 3 | ⬜ |
| Concierge unstaffed | Repurpose as seeding/GTM team | 2 | ⬜ GTM |
| No mobile | Responsive PWA now, native later | 3 | ⬜ |

**One line:** stop selling four empty marketplaces — pick football in one region, use agents to pour in
supply, build payments + messaging + verification so transactions actually close there, and let the
concierge team manufacture the first 1,000 real interactions by hand. FMV and mobile follow density.
