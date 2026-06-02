# Digital NIL — Design Document

**Project:** Digital NIL — Athletes in Control
**Stack:** React 18 (CDN, single-file) + Express + MongoDB + Socket.io
**Entry points:** [client/index.html](client/index.html) · [server/index.js](server/index.js)

---

## 1. Goals (2026 → 2027)

Tighten the existing platform into a cleaner, more elegant, app-store-style experience:

1. **Minimize & collapse the toolbar** — the left sidebar should collapse to an icon rail (and expand on hover/click), freeing horizontal space and giving the workspace a calmer first impression.
2. **Clean up the card display** — unify card surfaces, spacing, and shadows across Dashboard, Deals, Opportunities, Content Hub, Roster, Media Kits, Campaigns.
3. **2026 / 2027 app updates** — layer in the new modules and make the design like new apps made in 2026 may refreshes listed in §4.

---

## 2. Current Structure

### Roles & navigation
Defined in [client/index.html:175-201](client/index.html#L175-L201).

| Role    | Apps (in order)                                                                 |
|---------|---------------------------------------------------------------------------------|
| Athlete | Dashboard, Opportunities, My Deals, Content Hub, Analytics, Profile             |
| Brand   | Dashboard, Campaigns, Deals, Content, Analytics, Athletes, Profile              |
| Agent   | Dashboard, Roster, Deals, Media Kits, Marketing, Analytics, R&D Tracker, Profile |

### Shell
- [Sidebar](client/index.html#L203) — fixed 220 px dark rail, always expanded on desktop.
- [BottomNav](client/index.html#L228) — mobile tab bar (first 5 nav items).
- [App](client/index.html#L1798) — view switcher + socket.io + session boot.

### Theme tokens
Central palette `C` at [client/index.html:28-37](client/index.html#L28-L37) (red `#CC0000` primary, near-black sidebar `#0A0A0A`, slate text). All cards use the `.card` class defined at [client/index.html:42](client/index.html#L42).

---

## 3. Design Direction

### 3.1 Collapsible toolbar
- Default state on desktop: **collapsed rail (64 px)** showing icons only; labels appear on hover tooltip.
- Expanded state (220 px) on click of a chevron toggle pinned at the top of the rail.
- Persist user preference in `localStorage` (`as_sidebar_collapsed`).
- Active item: keep red accent bar on the left edge (4 px), drop the full-width red fill — too heavy when collapsed.
- Logo collapses to just the football tile; full "Digital NIL" wordmark only when expanded.
- User block at bottom collapses to avatar only; sign-out moves into a hover popover.
- Mobile bottom nav is unchanged.

### 3.2 Card cleanup
Update the global `.card` class and remove ad-hoc inline styles from each module:

| Property       | Today                                | Target                                                        |
|----------------|--------------------------------------|---------------------------------------------------------------|
| Background     | `#FFFFFF`                            | `#FFFFFF`                                                     |
| Border         | `1px solid #E5E7EB`                  | `1px solid #EEF1F5` (lighter)                                 |
| Radius         | 12 px                                | 14 px                                                         |
| Padding        | 20 px (16 px mobile)                 | 20 px / 24 px header rows; 16 px content rows                 |
| Shadow         | none                                 | `0 1px 2px rgba(15,23,42,.04), 0 1px 1px rgba(15,23,42,.03)`  |
| Hover (clickable cards) | none                        | `transform: translateY(-1px)` + shadow lift                   |
| Section header | inline `<h3>` with mixed weights     | Reusable `CardHeader` (title 15/700, optional action link)    |

Stat cards ([client/index.html:343-348](client/index.html#L343-L348)) should:
- Drop the colored value text — keep value `#111827`, move the role color onto a 2 px accent strip on the icon chip.
- Standardize icon tile (36 × 36, light tint of the accent color).

Deal / Opportunity / Roster rows should share a single **`ListRow`** primitive (avatar · title block · meta · trailing action) so all modules read the same.

### 3.3 Surface & spacing
- Page wrapper: `max-width: 1140 px`, padding `28 px` desktop / `16 px` mobile.
- Grid gap: standardize at `16 px` (currently mixes 12/16/20).
- Section spacing: `28 px` between major blocks.
- Page H1: 24/700, subtitle 14/400 muted — apply across all views (Dashboard already matches).

---

## 4. 2026 / 2027 App Updates

### 2026
- [ ] **Sidebar collapse + persist** (§3.1) — applies to all roles.
- [ ] **Card primitive refactor** (§3.2) — `Card`, `CardHeader`, `StatCard`, `ListRow` components extracted from inline JSX.
- [ ] **Deals 2.0** — split current `MyDeals` into tabs (Active / Pending / Completed) with cleaner status chips.
- [ ] **Content Hub redesign** — grid of media thumbnails with platform overlay badge; drop list rows.
- [ ] **Messaging app** (new nav item, all roles) — DMs between athlete ↔ brand ↔ agent, built on the existing socket.io channel.
- [ ] **CFB Stats inline on Roster cards** — collapse the current full-page CFB view into an expandable per-athlete panel.

### 2027
- [ ] **Payments app** — track payouts, invoices, 1099s; replaces the `paymentReceived` activity-only flow.
- [ ] **Compliance app** (school disclosure forms, state NIL rule checks) — required for athlete role.
- [ ] **Marketplace v2** — public-facing brand browse for opportunities with filtering by sport/school/follower tier.
- [ ] **Mobile app shell** — wrap the same React bundle in Capacitor; reuse `BottomNav`.
- [ ] **Theme switcher** — dark mode using the existing `C` token map.

---

## 5. Implementation Notes

- The client is a **single HTML file** with React via CDN and `React.createElement` (no JSX). Card primitives must follow the same pattern to avoid introducing a build step.
- Keep all new style under the injected `<style>` block at [client/index.html:40-86](client/index.html#L40-L86); avoid per-component inline duplicates.
- New nav items: extend `NAV_ATHLETE` / `NAV_BRAND` / `NAV_AGENT` and add a case in the `renderView` switch at [client/index.html:1848](client/index.html#L1848).
- Server routes live under [server/routes/](server/routes/); new apps should add a sibling route file and mount it in [server/index.js](server/index.js).
