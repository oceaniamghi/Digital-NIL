const YT_SEARCH = 'https://www.googleapis.com/youtube/v3/search';

// Channels whose uploads carry a rights-holder (NFL etc.) Content-ID claim that
// blocks off-site embeds with "This video contains content from NFL, who has
// blocked it from display on this website or application". The Data API's
// embeddable/syndicated flags are set by the uploader and do NOT reflect these
// claims, so the only reliable filter is to drop the claiming channels by title.
const BLOCKED_CHANNEL = /\b(nfl|national football league|nba|mlb|espn|fox sports|cbs sports|sec network|big ten network|acc network|pac-?12)\b/i;

// Return up to `limit` candidate highlight video IDs for an athlete, best match
// first, with league-owned channels removed. The client plays them in order and
// skips any that still report an embed block at playback (a famous, drafted
// athlete like Travis Hunter pulls NFL footage whose Content-ID claim can ride
// on non-league channels too), so the profile always lands on a clip that plays.
// Returns [] on any failure so a missing key / API error never blocks a save.
export async function findYouTubeReelIds({ name, school, position, sport } = {}, limit = 8) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key || !name) return [];

  const sportTerm = !sport || /football/i.test(sport) ? 'football' : sport;
  // Try a precise query first, then fall back to a looser one so a single
  // over-specific search never leaves an athlete without a reel. "college"
  // biases toward recruiting/school channels rather than pro broadcast footage.
  const queries = [
    [name, school, position, sportTerm, 'college highlights'].filter(Boolean).join(' '),
    [name, sportTerm, 'highlights'].filter(Boolean).join(' ')
  ];

  const ids = [];
  for (const q of queries) {
    const qs = new URLSearchParams({
      part: 'snippet',
      type: 'video',
      maxResults: '10',
      videoEmbeddable: 'true',
      videoSyndicated: 'true',
      safeSearch: 'strict',
      q,
      key
    });
    try {
      const res = await fetch(`${YT_SEARCH}?${qs}`);
      if (!res.ok) continue;
      const data = await res.json();
      for (const it of data?.items || []) {
        const id = it?.id?.videoId;
        if (id && !ids.includes(id) && !BLOCKED_CHANNEL.test(it?.snippet?.channelTitle || '')) {
          ids.push(id);
          if (ids.length >= limit) return ids;
        }
      }
    } catch {
      // try the next query
    }
  }
  return ids;
}

// Single watch URL for an athlete's default reel (used when saving a profile).
// highlightEmbed() turns the watch URL into an inline embed.
export async function findYouTubeReel(params) {
  const ids = await findYouTubeReelIds(params, 1);
  return ids.length ? `https://www.youtube.com/watch?v=${ids[0]}` : '';
}
