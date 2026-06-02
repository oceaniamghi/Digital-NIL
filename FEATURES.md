# Digital NIL — Feature Specification

**Project:** Digital NIL — *Athletes in Control*
**Stack:** React 18 (CDN, single-file, `React.createElement`) · Express · MongoDB (Mongoose) · Socket.io
**Entry points:** [client/index.html](client/index.html) · [server/index.js](server/index.js)

Status legend used throughout:
- **[Built]** — implemented and working in the current codebase
- **[Partial]** — partially implemented / env-gated / stubbed
- **[Proposed]** — designed here, not yet in code

---

## 1. Overview

Digital NIL is a Name-Image-Likeness (NIL) marketing platform that connects collegiate/pro **athletes** with **brands** for sponsorship deals, brokered and managed by **agents**. **The agent IS the admin** — the agent seat carries full admin power over its roster (sign, approve, and post on an athlete's behalf, with audit trail). On top of the athlete↔brand marketplace, the platform layers a full **agent CRM** (leads → pipeline → accounts → deals).

The app boots with seeded demo data — 16 real college-football athletes (with live ESPN/CFBD stats + headshots), 12 real brand sponsors (Nike, Jordan, Oakley, adidas, Gatorade, Red Bull, etc.), and a marketplace of sample deals — so it looks alive on first run ([server/index.js:100-539](server/index.js#L100-L539)).

---

## 2. Roles & Access Model

The `User.role` enum has three values: `athlete`, `brand`, `agent` ([server/models/User.js:15](server/models/User.js#L15)). **There is no separate `admin` role — the agent role *is* the admin.** Access is enforced server-side by `requireAuth` + `requireRole(...)` middleware ([server/middleware/auth.js](server/middleware/auth.js)) and client-side by per-role navigation maps ([client/index.html:476-506](client/index.html#L476-L506)).

| Role | Status | What it is |
|------|--------|-----------|
| **Athlete** | [Built] | The talent. Discovers opportunities, accepts/declines deals, tracks a personal deal pipeline, manages profile & media. |
| **Brand** | [Built] | The sponsor. Runs campaigns, posts deals, offers deals to specific athletes, reviews content, tracks spend & performance. |
| **Agent = Admin** | [Built] | The admin of the platform. Manages a roster of athletes with full admin power (sign/approve/post on their behalf, audit trail), runs the CRM (leads/pipeline/accounts), brokers deals, builds media kits, and owns browser-automation tooling. |

### 2.1 Agent = Admin: what the admin seat does
- An agent **represents** athletes via `User.agentId` / `agent.athletes[]` ([server/models/User.js:39,52](server/models/User.js#L39)).
- Agents act on behalf of athletes with admin authority — *"Act on behalf of any athlete on your roster — sign, approve, post — with full audit trail"* ([client/index.html:3642](client/index.html#L3642)).
- Every record in the CRM is **owner-scoped** (`owner: req.user._id`) so one agent/admin never sees another's pipeline ([server/routes/crm.js:17,24](server/routes/crm.js#L17)).

### 2.2 Per-role navigation (as shipped)
- **Athlete:** Home · Discover · **Pipeline** (kanban) · Deals · Inbox · Profile · Help
- **Brand:** Home · Campaigns · Deals · Inbox · Athletes (Sponsor Portal) · Profile · Help
- **Agent / Admin:** Home · Roster · **CRM** · Deals · Inbox · Media Kits · Marketing · Profile · Help

---

## 3. CRM Workflow (Agent-only) **[Built]**

The CRM is the agent's sponsor-acquisition engine. The entire route is gated to agents: `router.use(requireAuth, requireRole('agent'))` ([server/routes/crm.js:17](server/routes/crm.js#L17)). Five entities, all owner-scoped.

```
   LEAD            →  convert  →   COMPANY (Account)  +  CONTACT
 (raw inbound)                          │
                                        ▼
                                  OPPORTUNITY  ──(kanban stages)──▶  signed/active
                                        │                                 │
                                        │  link company → brand account   │ convert
                                        ▼                                 ▼
                                  CRM TIMELINE EVENTS              PLATFORM DEAL
                              (note/task/call/meeting/email)     (athlete↔brand)
```

### 3.1 Leads — front of the funnel
Model: [server/models/Lead.js](server/models/Lead.js)
- **Statuses:** `new → working → nurturing → qualified → unqualified → converted`
- **Ratings:** `hot / warm / cold`
- **Sources:** `inbound, referral, outbound, marketplace, event, social, other`
- **Auto lead scoring (0–100):** rating sets the floor (hot 55 / warm 35 / cold 15) and contactability/fit fields add points (email +15, phone +10, company +10, title +5, sport +5). Recomputed on every save ([server/models/Lead.js:9-17,46-50](server/models/Lead.js#L9-L17)).
- **Endpoints:** `GET/POST/PUT/DELETE /api/crm/leads`, plus `PUT /leads/:id/status` for quick status moves and `POST /leads/:id/convert` ([server/routes/crm.js:371-471](server/routes/crm.js#L371-L471)).

**Lead conversion** spins up a Company (Account) + a Contact, and optionally an Opportunity in one call; the lead is stamped `converted` with back-references to all three ([server/routes/crm.js:422-471](server/routes/crm.js#L422-L471)).

### 3.2 Companies (Accounts) & Contacts
- **Companies** ([server/models/Company.js](server/models/Company.js)) carry name, type, logo, domain/website, industry, location, tags, notes, and an optional **`linkedUser`** that ties the CRM account to a real onboarded **brand account** — required before an opportunity can become a platform deal.
- Each company listing is enriched on the fly with **open-opportunity count** and **pipeline value** via a Mongo aggregation ([server/routes/crm.js:30-39](server/routes/crm.js#L30-L39)).
- **Contacts** ([server/models/Contact.js](server/models/Contact.js)) belong to a company and track name, email, phone, title, tags, and `lastContactedAt` (auto-stamped when outreach email is sent).
- `GET /api/crm/brand-accounts` lists onboarded brands available to link ([server/routes/crm.js:80-88](server/routes/crm.js#L80-L88)).

### 3.3 Opportunities (the deal pipeline)
Model: [server/models/Opportunity.js](server/models/Opportunity.js)
- **Fields:** title, company, primaryContact, value, commissionPct, win-probability, target athletes, deliverables, sports, platforms, expectedCloseDate, source, lostReason, linkedDeal.
- **Guardrails:** an opportunity's company must belong to the agent before creation ([server/routes/crm.js:163-164](server/routes/crm.js#L163)).

### 3.4 Timeline events (activity log)
Model: [server/models/CrmEvent.js](server/models/CrmEvent.js) — every opportunity has a reverse-chronological timeline of:
- `note`, `task` (with due date + done flag), `call`, `meeting`
- `email` (logged with recipient/subject/status)
- `stage_change` (auto-logged on every kanban move, with from/to stage)

Endpoints: `GET/POST /opportunities/:id/events`, `PUT/DELETE /events/:id` ([server/routes/crm.js:299-341](server/routes/crm.js#L299-L341)).

### 3.5 Outreach email **[Partial — env-gated]**
`POST /opportunities/:id/email` composes and logs an outreach email; it is actually **sent only when `RESEND_API_KEY` is configured** (Resend), otherwise it's logged as a draft ([server/routes/crm.js:344-366](server/routes/crm.js#L344-L366), [server/lib/resend.js](server/lib/resend.js)). Sending stamps the contact's `lastContactedAt`.

### 3.6 Opportunity → Deal conversion
`POST /opportunities/:id/convert` turns a **signed/active** opportunity into a real platform `Deal` ([server/routes/crm.js:239-283](server/routes/crm.js#L239-L283)):
- Requires the company to be **linked to a brand account**.
- One target athlete → `active` deal assigned to that athlete; zero/many → `open` public deal.
- Maps CRM deliverables onto the deal, links `opportunity.linkedDeal`, advances stage to `active`, and writes both a CRM note and a platform Activity record.

---

## 4. Kanban Management **[Built]**

Two distinct kanban surfaces:

### 4.1 Agent CRM pipeline kanban
- **Stages:** `prospect → pitched → negotiating → contract_out → signed → active` (+ `lost`) ([server/models/Opportunity.js:10](server/models/Opportunity.js#L10)).
- **Default win-probability per stage** auto-applied on move: prospect 10% → pitched 25% → negotiating 50% → contract_out 75% → signed 90% → active 100% → lost 0% ([server/models/Opportunity.js:13-15](server/models/Opportunity.js#L13-L15)).
- **Drag-and-drop** between columns calls `PUT /opportunities/:id/stage`, which updates stage + probability + `stageEnteredAt` and auto-writes a `stage_change` timeline event ([server/routes/crm.js:209-236](server/routes/crm.js#L209-L236)).
- **Column UI:** each column shows a card count and **summed pipeline value**; cards lift on hover and fade while dragging; columns highlight red on drag-over ([client/index.html:250-261](client/index.html#L250-L261)).
- **Card drawer:** clicking a card slides in a right-hand drawer (480px) with the opportunity detail + timeline ([client/index.html:263-276](client/index.html#L263-L276)).

### 4.2 Athlete deal pipeline ("Pipeline" tab)
- Athletes get their own kanban-style **Pipeline** view (`tracker`, icon `view_kanban`) tracking their deals through the deal lifecycle and showing total open+pending value ([client/index.html:479](client/index.html#L479)).

---

## 5. Deals Lifecycle **[Built]**

Model: [server/models/Deal.js](server/models/Deal.js); routes: [server/routes/deals.js](server/routes/deals.js).
- **Status workflow:** `open → offered → applied → active → completed` (+ `declined`, `expired`) ([server/models/Deal.js:32-38](server/models/Deal.js#L32-L38)).
  - `offered` = brand offered a deal to a *specific* athlete awaiting acceptance.
  - `applied` = athlete applied to an open marketplace deal.
- **Deliverables** with their own sub-lifecycle: `pending → submitted → approved → posted`, each optionally linked to a Content record ([server/models/Deal.js:3-10](server/models/Deal.js#L3-L10)).
- **Compensation:** `flat / per_post / per_thousand_impressions / rev_share`.
- **Targeting:** platforms, sports, `minFollowers` floor.
- **Applications** array for open deals; **performance metrics** (impressions/clicks/engagements/reach); disclosure tag (`#ad`).
- **Visibility:** `isPublic` controls marketplace exposure.

---

## 6. Social Data & Browser Automation

### 6.1 Current implementation — RapidAPI HTTP scrapers **[Partial — env-gated]**
Social stats are pulled over HTTP (not a real browser) in [server/routes/socials.js](server/routes/socials.js):
- **Follower counts** for Instagram / TikTok / Twitter via RapidAPI providers (hosts overridable by env). The follower number is found by deep-walking the JSON response, so provider response-shape differences are tolerated ([server/routes/socials.js:12-64](server/routes/socials.js#L12-L64)).
- **Hard caching** (default 12h, `SOCIAL_CACHE_HOURS`) to protect API quota; returns `source: 'unconfigured'` when `RAPIDAPI_KEY` is unset ([server/routes/socials.js:66-101](server/routes/socials.js#L66-L101)).
- **Highlight reels** discovered via YouTube and cached 6h; the client plays candidate IDs in order and skips any blocked from embedding ([server/routes/socials.js:103-130](server/routes/socials.js#L103-L130), [server/lib/youtube.js](server/lib/youtube.js)).

> Note: There is currently **no Chromium / Puppeteer / Playwright** automation in the codebase — the platform relies on RapidAPI + YouTube HTTP APIs.

### 6.2 Headless Chromium automation — media-kit / share-card export **[Built — first slice shipped 2026-05-28]**
In-app **headless Chromium** (Playwright) that renders the app's **own** public pages to downloadable assets. Scope decision: Chromium drives *our* pages only — it is **not** a third-party scraping engine (that stays on the RapidAPI HTTP layer in §6.1).

- **What ships today**
  - **Dependency:** `playwright ^1.60.0` ([package.json:23](package.json#L23)); Chromium binary installed at `~/AppData/Local/ms-playwright`.
  - **Renderer:** [server/lib/render.js](server/lib/render.js) — lazily imports Playwright, **caches and reuses one browser** (relaunches if disconnected), launches with `--no-sandbox --disable-dev-shm-usage`. `prep()` does `goto(networkidle)` → waits for `document.fonts.ready` → 300ms settle.
    - `renderAthletePdf(url)` — A4 PDF, `emulateMedia('screen')` (keeps the dark theme, not print CSS), `printBackground`, 14px margins.
    - `renderAthleteCard(url)` — 1200×720 viewport at `deviceScaleFactor: 2`, screenshots the header `.card` element (falls back to a viewport shot).
  - **Routes:** [server/routes/export.js](server/routes/export.js) mounted at `/api/export` ([server/index.js:53](server/index.js#L53)):
    - `GET /api/export/athlete/:id/pdf` → media-kit PDF
    - `GET /api/export/athlete/:id/card` → share-card PNG
    - Both **`requireAuth`** (Chromium is heavy — never exposed anonymously); both render the same server's public `/athlete/:id` page; filenames are slugified from the athlete name.
  - **Graceful degrade:** any render failure (e.g. Chromium not installed on the host) throws → route returns **503**, so the app still boots and runs everywhere and only the export degrades — same philosophy as the env-gated Resend email (§3.5).
  - **Client:** PDF button on each Media Kits card ([client/index.html:2454](client/index.html#L2454)) and "Media Kit" / "Card" buttons in `AthleteProfile` ([client/index.html:2970](client/index.html#L2970)); both authed `fetch` → blob → download ([client/index.html:2406](client/index.html#L2406), [client/index.html:2932](client/index.html#L2932)). Verified end-to-end (valid PDF + clean PNG card).

- **Still planned (render-our-own-pages only)**
  - Additional render targets via `render.js` (e.g. campaign one-pagers, roster decks, deal summaries).
  - **Deliberately NOT doing:** proof-of-post screenshots of live social posts, follower/stat scraping for unsupported platforms, and lead auto-import — all rejected as anti-bot / ToS-fragile. Stats stay on the RapidAPI layer (§6.1).

- **Infra caveat:** Chromium is heavy and won't fit a tiny host. On deploy the browser binary must be present (or the `/api/export` endpoints return 503).

- **Note — two different "Chromium" things:** the dev harness's Playwright **MCP** tools (E2E-testing/screenshotting the running app) are separate from this in-app `playwright` **dependency** (the shipped product feature).

---

## 7. Real-time, Messaging & Activity **[Built / Partial]**
- **Socket.io** server with per-user rooms (`user:${userId}`) for live notifications ([server/index.js:67-75](server/index.js#L67-L75)).
- **Inbox / Messaging** nav item across all roles (DMs athlete↔brand↔agent on the socket channel) — listed as a 2026 module in [DESIGN.md](DESIGN.md); UI present, deep-links Financials/Content/Analytics into the Inbox hub ([client/index.html:507-510](client/index.html#L507-L510)).
- **Activity feed** ([server/models/Activity.js](server/models/Activity.js), [server/routes/activity.js](server/routes/activity.js)) records deal offers, conversions, payments, etc.

---

## 8. Supporting Modules **[Built]**

| Module | Roles | Notes |
|--------|-------|-------|
| **Dashboard / Home** | all | Role-specific KPIs — portfolio valuation & pipeline (athlete), spend & performance (brand), roster & commission (agent). |
| **Roster** | agent | Roster of represented athletes; agents see only their own ([client/index.html:203](client/index.html#L203)). |
| **Discover / Opportunities** | athlete | Browse + bookmark (`savedDeals`) public marketplace deals. |
| **Sponsor Portal / Athletes** | brand | Browse athletes, send targeted offers. |
| **Campaigns** | brand | [server/routes/campaigns.js](server/routes/campaigns.js) — group deals under a campaign. |
| **Content Hub** | athlete/agent/brand | [server/routes/content.js](server/routes/content.js) — content tied to deliverables; review/approve flow. |
| **Media Kits** | agent | Shareable athlete one-pagers. |
| **Marketing (Talent Marketing)** | agent | Promote roster athletes. |
| **Analytics** | all | [server/routes/analytics.js](server/routes/analytics.js) — deal/engagement metrics. |
| **CFB Stats** | athlete/agent | [server/routes/cfbd.js](server/routes/cfbd.js) — live CFBD stats + ESPN headshots; auto-resolves latest year with data. |
| **Time Logs / R&D Tracker** | agent | [server/routes/timelogs.js](server/routes/timelogs.js) — track product/equity/book/film work outside standard NIL flow. |
| **Profile / Help** | all | Profile editor; role-aware help/onboarding tabs. |

---

## 9. Per-Role Feature Matrix

The **Agent / Admin** column is one seat — the agent role holds all admin powers.

| Capability | Athlete | Brand | Agent / Admin |
|-----------|:------:|:----:|:----:|
| Marketplace discovery / bookmark | ✓ | — | ✓ |
| Post public deal listing | — | ✓ (Free: 1 live → Elite: ∞) | ✓ (broker) |
| **Direct offer to athlete** | — | ✓ *(Starter+)* | ✓ (broker) |
| **Funded recruitment trips** | — | ✓ *(Elite)* | — |
| Accept / decline deals | ✓ | — | ✓ (on behalf) |
| Personal deal **pipeline kanban** | ✓ | — | ✓ |
| **CRM** (leads/accounts/contacts) | — | — | ✓ |
| **CRM opportunity kanban** | — | — | ✓ |
| **Leads flow** + scoring + convert | — | — | ✓ |
| Outreach email (Resend) | — | — | ✓ |
| Campaigns | — | ✓ *(Starter+, capped per tier)* | — |
| **Subscription plans & billing** (Stripe) | ✓ | ✓ | ✓ |
| Roster management | — | — | ✓ |
| Media kits / talent marketing | — | — | ✓ |
| Content review / approval | ✓ | ✓ | ✓ |
| Analytics | ✓ | ✓ | ✓ |
| Social stats / highlight reels | ✓ | ✓ | ✓ |
| **Chromium export** (media-kit PDF / share-card PNG) | — | — | ✓ *[Built]* |
| Inbox / messaging | ✓ | ✓ | ✓ |

---

## 10. Integrations & Configuration

| Integration | Purpose | Env | Status |
|-------------|---------|-----|--------|
| MongoDB | Primary store; **falls back to in-memory Mongo** when URI is a placeholder/unreachable | `MONGODB_URI` | [Built] |
| Socket.io | Real-time notifications/messaging | — | [Built] |
| RapidAPI | IG/TikTok/Twitter follower counts | `RAPIDAPI_KEY`, `RAPIDAPI_*_HOST`, `SOCIAL_CACHE_HOURS` | [Partial] |
| YouTube | Highlight-reel discovery | (see `lib/youtube.js`), `REEL_CACHE_HOURS` | [Partial] |
| CFBD / ESPN | College-football stats + headshots | — | [Built] |
| Resend | Transactional / outreach email | `RESEND_API_KEY` | [Partial] |
| JWT + bcrypt | Auth (Bearer tokens, hashed passwords) | `JWT_SECRET` | [Built] |
| Seeding | Demo users/athletes/brands/deals | `SEED_TEST_USERS`, `NODE_ENV` | [Built] |
| Playwright (Chromium) | In-app headless rendering → media-kit PDF / share-card PNG export | `PLAYWRIGHT_BROWSERS_PATH` (binary must be installed) | [Built] |

---

## 11. Roadmap

From [DESIGN.md](DESIGN.md) plus the items requested here:

**2026**
- Sidebar collapse + persist (all roles)
- Card primitive refactor (`Card`, `CardHeader`, `StatCard`, `ListRow`)
- Deals 2.0 (Active / Pending / Completed tabs)
- Content Hub redesign (thumbnail grid + platform badges)
- Messaging app (DMs on the socket.io channel)
- CFB stats inline on roster cards

**2027**
- Payments app (payouts, invoices, 1099s)
- Compliance app (school disclosure forms, state NIL checks)
- Marketplace v2 (public brand browse + sport/school/follower filters)
- Mobile shell (Capacitor wrapping the same React bundle)
- Theme switcher

**Subscription monetization (all roles)**
- **Shipped 2026-06-01:** Role-based subscription tiers on `User.plan`, defined once in [`server/lib/plans.js`](server/lib/plans.js) and mirrored in the client. Per-tier **limits** + **capabilities** gate features; the server enforces, the client previews.
  - **Brand:** Free · Starter $1,000 · Growth $2,500 · Pro $5,000 · **Elite $10,000/mo**. Gates: active-deal count, campaign count, direct offers (Starter+), funded recruitment trips (Elite).
  - **Athlete:** Free · Plus $19 · Pro $49/mo. Gates: media-kit PDF export, media-kit items, featured placement, brand outreach.
  - **Agent:** Free · Starter $99 · Pro $299 · Agency $799/mo. Gates: roster size, CRM outreach email, analytics.
- **Stripe billing** ([`server/routes/billing.js`](server/routes/billing.js)): `GET /api/billing/config`, `POST /api/billing/checkout {plan}` (subscription Checkout), `POST /api/billing/cancel`, and a signature-verified `POST /api/billing/webhook` that syncs `plan` on `checkout.session.completed` / `customer.subscription.deleted|updated`. Degrades gracefully — with no real `STRIPE_SECRET_KEY` it dev-grants instantly (non-prod) so the flow stays testable. Vendor override: `POST /api/owner/plan {email,plan}`.
- Gating contract: any blocked feature returns **402 `{error:'Upgrade required', message, upgrade}`**; the client's global `signalUpgrade` shows one upgrade prompt → role-aware `Plans` marketing page.
- **20% platform service fee on every closed deal — all tiers.** `PLATFORM_FEE_RATE` (`server/models/Deal.js`) is stamped onto each deal at creation (`platformFeeRate`); `platformFee` / `athleteNet` virtuals expose the breakdown. On completion the athlete is credited the **net** (gross − fee). Shown via the shared `FeeBreakdown` component + Plans page.
- **Railway:** `stripe` is a runtime dependency (installed by the Dockerfile). Set `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`, and `BASE_URL` (public HTTPS domain) in the Railway env, and point a Stripe webhook at `https://<domain>/api/billing/webhook`. `trust proxy` + raw-body webhook capture are already wired in `server/index.js`.

**Chromium automation (§6.2)**
- **Shipped 2026-05-28:** media-kit PDF + share-card PNG export (renders the app's own `/athlete/:id` page via Playwright). Agent/admin-owned.
- **Planned:** more render targets through `server/lib/render.js` (campaign one-pagers, roster decks, deal summaries).
- **Explicitly dropped:** proof-of-post screenshots, stat scraping for unsupported platforms, lead auto-import — rejected as anti-bot / ToS-fragile; Chromium renders our own pages only.
