import { findYouTubeReel } from './youtube.js';
import { findEspnHeadshotId } from '../routes/cfbd.js';

// Coach-profile auto-enrichment (scrape → confirm). Pulls a press-conference /
// program reel from YouTube and a staff headshot id, then writes them as UNVERIFIED
// suggestions in `profileSources`. Coach-entered (input) values are authoritative
// and are never overwritten — enrichment only fills blanks and proposes sources the
// coach must confirm. Degrades to a no-op when the API keys aren't configured.
//
// Provenance map shape on User.profileSources:
//   { avatar: { source: 'staff', value: '<url>', status: 'unverified' }, ... }
export async function enrichCoachProfile(coach) {
  const sources = { ...(coach.profileSources || {}) };
  const filled = [];

  // Intro/press-conference reel via YouTube (same finder athletes use).
  if (!coach.introVideoUrl) {
    const reel = await findYouTubeReel({ name: coach.name, school: coach.program, position: coach.coachTitle, sport: coach.sportCoached }).catch(() => '');
    if (reel) { sources.introVideoUrl = { source: 'youtube', value: reel, status: 'unverified' }; filled.push('introVideoUrl'); }
  }

  // Headshot id (best-effort; coaches have no ESPN college-football headshot the way
  // players do, so this is a suggestion the coach confirms or replaces).
  if (!coach.avatar) {
    const id = await findEspnHeadshotId(coach.name, coach.program).catch(() => '');
    if (id) {
      const url = `https://a.espncdn.com/i/headshots/college-football/players/full/${id}.png`;
      sources.avatar = { source: 'cfbd', value: url, status: 'unverified' };
      filled.push('avatar');
    }
  }

  coach.profileSources = sources;
  await coach.save();
  return { filled, profileSources: sources, note: 'Scraped fields are unverified — confirm them on your profile. Your own entries always take priority.' };
}
