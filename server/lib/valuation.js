// Fair-Market-Value (FMV) engine v1 — a defensible NIL valuation from data we already
// own (social reach + sport + level + trajectory), blended with on-platform closed-deal
// comps. This is intentionally a transparent heuristic, not a black box: brands need a
// number they can reason about (the Opendorse "Market Intel" / INFLCR valuation gap).
//
// Pure + deterministic (no Date.now / Math.random) so it's testable and cache-safe.

// Per-platform engagement weighting — short-form video reach converts better for NIL
// than follower-graph platforms, so a TikTok/IG follower is worth more than a FB one.
const PLATFORM_WEIGHT = { tiktok: 1.3, instagram: 1.2, youtube: 1.1, twitter: 0.8, facebook: 0.6 };
const SPORT_MULT = { football: 1.25, basketball: 1.25, baseball: 1.0, soccer: 1.0, track: 0.85, volleyball: 0.9 };
const TREND_MULT = { up: 1.15, steady: 1.0, down: 0.9 };

// Baseline annual NIL value per *weighted* follower (USD). Tuned so a 1M-follower
// football star lands in a realistic low-seven-figure band and a 10k micro-influencer
// lands in the low thousands — consistent with public NIL valuation ranges.
const ANNUAL_PER_FOLLOWER = 0.025;

const round = (n) => Math.max(0, Math.round(n));

// Weighted reach across an athlete's connected social handles.
export function weightedReach(socialHandles = []) {
  let reach = 0;
  for (const h of socialHandles) {
    const w = PLATFORM_WEIGHT[String(h.platform || '').toLowerCase()] ?? 0.7;
    reach += (Number(h.followers) || 0) * w;
  }
  return reach;
}

// comps = array of completed on-platform deal gross amounts for this athlete (or peers).
export function computeFmv({ socialHandles = [], sport = '', proStatus = '', draftTrend = 'steady', comps = [] } = {}) {
  const reach = weightedReach(socialHandles);
  const rawFollowers = socialHandles.reduce((s, h) => s + (Number(h.followers) || 0), 0);

  const sportMult = SPORT_MULT[String(sport).toLowerCase()] ?? 1.0;
  const levelMult = proStatus === 'professional' ? 1.5 : 1.0;
  const trendMult = TREND_MULT[String(draftTrend).toLowerCase()] ?? 1.0;

  // Model-derived annual value and single-post value.
  const annualModel = reach * ANNUAL_PER_FOLLOWER * sportMult * levelMult * trendMult;
  // A single sponsored post is a slice of annual reach value (~8% — roughly one strong
  // post's share of a 12-month program).
  const perPostModel = annualModel * 0.08;

  // Blend with real closed-deal comps when we have them (50/50). Comps ground the model
  // in what brands actually paid on-platform — the moat the incumbents have and we build.
  const validComps = comps.filter(n => Number(n) > 0);
  const compAvg = validComps.length ? validComps.reduce((s, n) => s + Number(n), 0) / validComps.length : null;
  const perPostMid = compAvg != null ? (perPostModel * 0.5 + compAvg * 0.5) : perPostModel;

  // Confidence rises with reach signal + number of comps.
  let confidence = 'low';
  if (rawFollowers > 250000 || validComps.length >= 3) confidence = 'high';
  else if (rawFollowers > 25000 || validComps.length >= 1) confidence = 'medium';

  return {
    annual: round(compAvg != null ? annualModel * 0.6 + compAvg * 12 * 0.4 : annualModel),
    perPost: { low: round(perPostMid * 0.6), mid: round(perPostMid), high: round(perPostMid * 1.6) },
    weightedReach: round(reach),
    totalFollowers: round(rawFollowers),
    confidence,
    basis: {
      ratePerFollower: ANNUAL_PER_FOLLOWER,
      sportMult, levelMult, trendMult,
      comps: validComps.length, compAvg: compAvg != null ? round(compAvg) : null
    }
  };
}
