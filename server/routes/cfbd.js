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

// GET /api/cfbd/search?name=&team=
// Search for a player by name (and optionally school)
router.get('/search', requireAuth, async (req, res) => {
  try {
    const { name, team } = req.query;
    if (!name) return res.status(400).json({ error: 'name required' });
    const qs = new URLSearchParams({ searchTerm: name });
    if (team) qs.set('team', team);
    const data = await cfbdFetch(`/player/search?${qs}`);
    res.json({ players: data });
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
    for (const game of (data || [])) {
      const team = game.teams?.find(t => t.players?.some(p => String(p.id) === String(playerId)));
      if (!team) continue;
      const player = team.players?.find(p => String(p.id) === String(playerId));
      if (player) {
        const statMap = {};
        for (const cat of (player.categories || [])) {
          for (const type of (cat.types || [])) {
            statMap[`${cat.name}_${type.name}`] = type.stat;
          }
        }
        games.push({
          gameId: game.id,
          week: game.week,
          opponent: game.homeTeam === team.school ? game.awayTeam : game.homeTeam,
          homeAway: game.homeTeam === team.school ? 'home' : 'away',
          ...statMap
        });
      }
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
// Full team roster — useful for browsing athletes by school
router.get('/roster', requireAuth, async (req, res) => {
  try {
    const { team, year = new Date().getFullYear() } = req.query;
    if (!team) return res.status(400).json({ error: 'team required' });
    const data = await cfbdFetch(`/roster?team=${encodeURIComponent(team)}&year=${year}`);
    res.json({ roster: data });
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
      for (const game of gamesRaw.value) {
        const teamData = game.teams?.find(t => t.players?.some(p => String(p.id) === String(id)));
        if (!teamData) continue;
        const player = teamData.players?.find(p => String(p.id) === String(id));
        if (player) {
          const statMap = {};
          for (const cat of (player.categories || [])) {
            for (const type of (cat.types || [])) {
              statMap[`${cat.name}_${type.name}`] = type.stat;
            }
          }
          games.push({
            gameId: game.id, week: game.week,
            opponent: game.homeTeam === teamData.school ? game.awayTeam : game.homeTeam,
            homeAway: game.homeTeam === teamData.school ? 'home' : 'away',
            ...statMap
          });
        }
      }
    }
    res.json({ stats, games, year: yr, team });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
