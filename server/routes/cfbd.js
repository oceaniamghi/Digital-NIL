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

// GET /api/cfbd/search?name=&team=
// Search for a player by name (and optionally school)
router.get('/search', requireAuth, async (req, res) => {
  try {
    const { name, team } = req.query;
    if (!name) return res.status(400).json({ error: 'name required' });
    const qs = new URLSearchParams({ searchTerm: name });
    if (team) qs.set('team', team);
    const data = await cfbdFetch(`/player/search?${qs}`);
    res.json({ players: mergePlayerSearch(data) });
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
    const normalized = roster.map(p => ({
      ...p,
      name: p.name || [p.firstName || p.first_name, p.lastName || p.last_name].filter(Boolean).join(' ').trim()
    }));
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
