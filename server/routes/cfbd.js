import express from 'express';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();
const BASE = 'https://api.collegefootballdata.com';

function cfbdHeaders() {
  const key = process.env.CFBD_API_KEY;
  if (!key) throw new Error('CFBD_API_KEY not set');
  return { 'Authorization': `Bearer ${key}`, 'Accept': 'application/json' };
}

async function cfbdFetch(path) {
  const res = await fetch(`${BASE}${path}`, { headers: cfbdHeaders() });
  if (!res.ok) throw new Error(`CFBD API ${res.status}: ${await res.text()}`);
  return res.json();
}

// Resolve a CFBD/ESPN athlete id from a name (+ optional school). CFBD's player
// id aligns with the ESPN headshot id used across the app, so this is what feeds
// espnHeadshot()/the avatar URL. Prefers an exact name match, else the first hit.
// Returns '' when CFBD is unconfigured or nothing usable is found (never throws).
export async function findEspnHeadshotId(name, team) {
  if (!process.env.CFBD_API_KEY || !name) return '';
  try {
    const qs = new URLSearchParams({ searchTerm: name });
    if (team) qs.set('team', team);
    const data = await cfbdFetch(`/player/search?${qs}`);
    if (!Array.isArray(data) || !data.length) return '';
    const lc = name.trim().toLowerCase();
    const full = p => (p.name || `${p.firstName || ''} ${p.lastName || ''}`).trim().toLowerCase();
    const pick = data.find(p => full(p) === lc) || data[0];
    return pick && pick.id != null ? String(pick.id) : '';
  } catch {
    return '';
  }
}

// CFBD's /player/search returns one row PER school a player has been rostered at,
// all sharing the same `id` (e.g. a transfer shows up once for each team). That
// makes a single person look like "a bunch" of results. Collapse rows by id into
// the single richest record: keep the most-complete field values, remember every
// team as transfer history, and surface the primary (richest) school first.
function isBlank(v) {
  return v == null || v === '' || (typeof v === 'string' && v.toLowerCase().includes('null'));
}
function mergePlayerSearch(players) {
  if (!Array.isArray(players)) return [];
  const RICHNESS = ['team', 'position', 'weight', 'height', 'jersey', 'hometown', 'teamColor'];
  const byId = new Map();
  for (const p of players) {
    const id = String(p.id);
    const score = RICHNESS.reduce((n, k) => n + (isBlank(p[k]) ? 0 : 1), 0);
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, { player: { ...p }, score, teams: p.team ? [p.team] : [] });
      continue;
    }
    if (p.team && !existing.teams.includes(p.team)) existing.teams.push(p.team);
    // Backfill any field this row has that the merged record is missing.
    for (const k of Object.keys(p)) {
      if (isBlank(existing.player[k]) && !isBlank(p[k])) existing.player[k] = p[k];
    }
    // A richer row wins the player's primary identity (team + colors).
    if (score > existing.score) {
      existing.player.team = p.team;
      existing.player.teamColor = p.teamColor;
      existing.player.teamColorSecondary = p.teamColorSecondary;
      existing.score = score;
    }
  }
  // Most-complete players first so the best match is at the top of the dropdown.
  return [...byId.values()]
    .sort((a, b) => b.score - a.score)
    .map(e => ({ ...e.player, teams: e.teams, teamCount: e.teams.length }));
}

// CFBD's /recruiting/players IGNORES searchTerm — it only filters by year/team.
// But a recruit's `athleteId` is the SAME id space as /player/search's `id`
// (verified), so we enrich players with recruit data by pulling the recruiting
// classes for the teams already in the result set and matching on athleteId
// (falling back to a normalized name match). Bounded: a class is ~20-30 rows.
const RECRUIT_YEARS = [2025, 2024, 2023, 2022, 2021, 2020];
const nameKey = n => (n || '').toLowerCase().replace(/[^a-z]/g, '');

function recruitFields(r) {
  if (!r) return null;
  return {
    stars: r.stars ?? null,
    recruitRating: r.rating ?? null,
    recruitRank: r.ranking ?? null,
    committedTo: r.committedTo ?? null,
    recruitYear: r.year ?? null,
    hometownCity: r.city ?? null,
    hometownState: r.stateProvince ?? null,
    highSchool: r.school ?? null,
    hasRecruitData: true
  };
}

// Pull recruiting classes for the given teams across recent years; index every
// recruit by athleteId and by name so callers can match either way.
async function buildRecruitIndex(teams, years = RECRUIT_YEARS) {
  const jobs = [];
  for (const team of teams) {
    for (const yr of years) {
      jobs.push(
        cfbdFetch(`/recruiting/players?year=${yr}&team=${encodeURIComponent(team)}`)
          .then(list => (Array.isArray(list) ? list : []))
          .catch(() => [])
      );
    }
  }
  const byAthlete = new Map();
  const byName = new Map();
  for (const list of await Promise.all(jobs)) {
    for (const r of list) {
      if (r.athleteId != null && !byAthlete.has(String(r.athleteId))) byAthlete.set(String(r.athleteId), r);
      const nk = nameKey(r.name);
      if (nk && !byName.has(nk)) byName.set(nk, r);
    }
  }
  return { byAthlete, byName };
}

// Attach recruiting data to merged player-search results, matched by athleteId
// then name. Caps the team fan-out so an ambiguous search stays responsive.
async function attachRecruiting(players) {
  if (!players.length) return players;
  const teams = [];
  for (const p of players) {
    for (const t of (p.teams && p.teams.length ? p.teams : [p.team])) {
      if (t && !teams.includes(t)) teams.push(t);
    }
  }
  if (!teams.length) return players;
  const { byAthlete, byName } = await buildRecruitIndex(teams.slice(0, 6));
  return players.map(p => {
    const r = byAthlete.get(String(p.id)) || byName.get(nameKey(p.name));
    const rf = recruitFields(r);
    return rf ? { ...p, ...rf } : p;
  });
}

// /player/search only knows players who've been on a college roster, so brand-new
// HS recruits (the 2024–2026 classes) never show up there. CFBD DOES have those
// classes via /recruiting/players, but it IGNORES searchTerm — so we pull each full
// class ONCE, cache it in memory (classes are large but effectively static), and
// filter by name ourselves. This is what surfaces incoming recruits in search.
const RECRUIT_SEARCH_YEARS = [2026, 2025, 2024];
const recruitClassCache = new Map(); // year -> full class array (cached for process lifetime)

async function getRecruitClass(year) {
  if (recruitClassCache.has(year)) return recruitClassCache.get(year);
  const list = await cfbdFetch(`/recruiting/players?year=${year}`)
    .then(l => (Array.isArray(l) ? l : []))
    .catch(() => []);
  if (list.length) recruitClassCache.set(year, list); // don't cache empty (e.g. future class not published yet)
  return list;
}

// Name-search recruits across recent HS classes. Substring match on the
// letters-only name so "sheridan" or "juju" both work. Returns recruit-shaped rows.
async function searchRecruitsByName(name, years = RECRUIT_SEARCH_YEARS) {
  const q = nameKey(name);
  if (!q) return [];
  const lists = await Promise.all(years.map(getRecruitClass));
  const hits = [];
  for (const list of lists) {
    for (const r of list) {
      if (r.athleteId != null && nameKey(r.name).includes(q)) {
        hits.push({
          id: r.athleteId, name: r.name, position: r.position,
          team: r.committedTo || null, height: r.height, weight: r.weight,
          jersey: null, isRecruit: true, ...recruitFields(r)
        });
      }
    }
  }
  hits.sort((a, b) => (b.stars || 0) - (a.stars || 0) || (a.recruitRank || 1e9) - (b.recruitRank || 1e9));
  return hits.slice(0, 25); // cap so a common surname doesn't flood the UI
}

// GET /api/cfbd/search?name=&team=&recruits=0
// Search rostered players (enriched with recruiting data) AND incoming HS recruits
// from the 2024–2026 classes. recruits=0 returns rostered players only.
router.get('/search', requireAuth, async (req, res) => {
  try {
    const { name, team } = req.query;
    if (!name) return res.status(400).json({ error: 'name required' });
    const qs = new URLSearchParams({ searchTerm: name });
    if (team) qs.set('team', team);
    const data = await cfbdFetch(`/player/search?${qs}`);
    const merged = mergePlayerSearch(data);
    if (req.query.recruits === '0') return res.json({ players: merged });

    const enriched = await attachRecruiting(merged);
    // Pull HS recruits by name and drop any who are already a rostered hit
    // (same athleteId/name) so a committed-and-rostered player isn't duplicated.
    const known = new Set();
    for (const p of enriched) { known.add(String(p.id)); known.add(nameKey(p.name)); }
    const recruits = (await searchRecruitsByName(name))
      .filter(r => !known.has(String(r.id)) && !known.has(nameKey(r.name)));
    res.json({ players: [...enriched, ...recruits] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/cfbd/stats?playerId=&year=&team=
// Season-level stats for a player
router.get('/stats', requireAuth, async (req, res) => {
  try {
    const { playerId, year = new Date().getFullYear(), team } = req.query;
    if (!team) return res.status(400).json({ error: 'team required' });
    const data = await cfbdFetch(`/stats/player/season?year=${year}&team=${encodeURIComponent(team)}`);
    const filtered = playerId
      ? (Array.isArray(data) ? data.filter(s => String(s.playerId) === String(playerId)) : [])
      : (Array.isArray(data) ? data : []);
    res.json({ stats: filtered });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/cfbd/games?playerId=&year=&team=
// Game-by-game stats for a player
router.get('/games', requireAuth, async (req, res) => {
  try {
    const { playerId, year = new Date().getFullYear(), team } = req.query;
    if (!playerId) return res.status(400).json({ error: 'playerId required' });
    if (!team) return res.status(400).json({ error: 'team required' });
    const qs = new URLSearchParams({ year: String(year), team, seasonType: 'regular' });
    const data = await cfbdFetch(`/games/players?${qs}`);
    // Flatten into per-game rows for easier rendering
    const games = [];
    let gameNum = 0;
    for (const game of (data || [])) {
      const playerTeam = game.teams?.find(t =>
        t.categories?.some(cat =>
          cat.types?.some(type =>
            type.athletes?.some(a => String(a.id) === String(playerId))
          )
        )
      );
      if (!playerTeam) continue;
      gameNum++;
      const opponentTeam = game.teams?.find(t => t.team !== playerTeam.team);
      const statMap = {};
      for (const cat of (playerTeam.categories || [])) {
        for (const type of (cat.types || [])) {
          const athlete = type.athletes?.find(a => String(a.id) === String(playerId));
          if (athlete) statMap[`${cat.name}_${type.name}`] = athlete.stat;
        }
      }
      games.push({
        gameId: game.id, game: gameNum,
        homeAway: playerTeam.homeAway,
        opponent: opponentTeam?.team || '—',
        result: playerTeam.points != null && opponentTeam?.points != null
          ? (playerTeam.points > opponentTeam.points ? 'W' : playerTeam.points < opponentTeam.points ? 'L' : 'T')
            + ' ' + playerTeam.points + '-' + opponentTeam.points
          : '',
        ...statMap
      });
    }
    res.json({ games });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/cfbd/recruiting?name=&year=
// Recruiting profile & ranking
router.get('/recruiting', requireAuth, async (req, res) => {
  try {
    const { name, year, team } = req.query;
    const qs = new URLSearchParams();
    if (name) qs.set('searchTerm', name);
    if (year) qs.set('year', year);
    if (team) qs.set('team', team);
    const data = await cfbdFetch(`/recruiting/players?${qs}`);
    res.json({ recruits: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/cfbd/roster?team=&year=
// Full team roster — useful for browsing athletes by school. Walks back up to
// 2 prior years if the requested year has no data yet (CFBD lags in offseason).
router.get('/roster', requireAuth, async (req, res) => {
  try {
    const { team } = req.query;
    if (!team) return res.status(400).json({ error: 'team required' });
    const requested = Number(req.query.year) || new Date().getFullYear();
    let roster = [];
    let usedYear = requested;
    for (let i = 0; i < 3; i++) {
      const yr = requested - i;
      const data = await cfbdFetch(`/roster?team=${encodeURIComponent(team)}&year=${yr}`).catch(() => []);
      if (Array.isArray(data) && data.length) { roster = data; usedYear = yr; break; }
    }
    // Normalize: CFBD roster returns firstName/lastName; player-search returns name.
    // Add `name` so the same UI row renderer works for both.
    let normalized = roster.map(p => ({
      ...p,
      name: p.name || [p.firstName || p.first_name, p.lastName || p.last_name].filter(Boolean).join(' ').trim()
    }));

    // Enrich roster with recruiting data, and append this team's incoming
    // recruits (most recent two classes) who aren't on the roster yet — so
    // browsing a school surfaces committed recruits too, not just current players.
    if (req.query.recruits !== '0') {
      const { byAthlete, byName } = await buildRecruitIndex([team]);
      const onRoster = new Set();
      normalized = normalized.map(p => {
        if (p.id != null) onRoster.add(String(p.id));
        onRoster.add(nameKey(p.name));
        const r = byAthlete.get(String(p.id)) || byName.get(nameKey(p.name));
        const rf = recruitFields(r);
        return rf ? { ...p, ...rf } : p;
      });
      const recentClasses = [usedYear, usedYear - 1];
      const incoming = [...byAthlete.values()]
        .filter(r => recentClasses.includes(r.year))
        .filter(r => !onRoster.has(String(r.athleteId)) && !onRoster.has(nameKey(r.name)))
        .sort((a, b) => (a.ranking || 1e9) - (b.ranking || 1e9))
        .map(r => ({
          id: r.athleteId, name: r.name, team, position: r.position,
          height: r.height, weight: r.weight, jersey: null,
          isRecruit: true, ...recruitFields(r)
        }));
      normalized = [...normalized, ...incoming];
    }

    res.json({ roster: normalized, year: usedYear });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/cfbd/player/:id/profile?year=&team=
// Combined stats + games for one player. Uses /player/usage to resolve team when not provided.
router.get('/player/:id/profile', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const yr = Number(req.query.year) || new Date().getFullYear();
    let team = req.query.team;

    // Resolve team via usage endpoint if not supplied
    if (!team) {
      const usage = await cfbdFetch(`/player/usage?year=${yr}&playerId=${id}`).catch(() => []);
      const entry = Array.isArray(usage) ? usage.find(u => String(u.id) === String(id)) : null;
      team = entry?.team;
    }

    if (!team) {
      return res.json({ stats: [], games: [], year: yr, note: 'No data found for this player/year' });
    }

    const [statsRaw, gamesRaw] = await Promise.allSettled([
      cfbdFetch(`/stats/player/season?year=${yr}&team=${encodeURIComponent(team)}`),
      cfbdFetch(`/games/players?year=${yr}&team=${encodeURIComponent(team)}&seasonType=regular`)
    ]);

    const allStats = statsRaw.status === 'fulfilled' && Array.isArray(statsRaw.value) ? statsRaw.value : [];
    const stats = allStats.filter(s => String(s.playerId) === String(id));

    const games = [];
    if (gamesRaw.status === 'fulfilled' && Array.isArray(gamesRaw.value)) {
      let gameNum = 0;
      for (const game of gamesRaw.value) {
        // structure: game.teams[].categories[].types[].athletes[{id,name,stat}]
        const playerTeam = game.teams?.find(t =>
          t.categories?.some(cat =>
            cat.types?.some(type =>
              type.athletes?.some(a => String(a.id) === String(id))
            )
          )
        );
        if (!playerTeam) continue;
        gameNum++;
        const opponentTeam = game.teams?.find(t => t.team !== playerTeam.team);
        const statMap = {};
        for (const cat of (playerTeam.categories || [])) {
          for (const type of (cat.types || [])) {
            const athlete = type.athletes?.find(a => String(a.id) === String(id));
            if (athlete) statMap[`${cat.name}_${type.name}`] = athlete.stat;
          }
        }
        games.push({
          gameId: game.id,
          game: gameNum,
          homeAway: playerTeam.homeAway,
          opponent: opponentTeam?.team || '—',
          result: playerTeam.points != null && opponentTeam?.points != null
            ? (playerTeam.points > opponentTeam.points ? 'W' : playerTeam.points < opponentTeam.points ? 'L' : 'T')
              + ' ' + playerTeam.points + '-' + opponentTeam.points
            : '',
          ...statMap
        });
      }
    }
    res.json({ stats, games, year: yr, team });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
