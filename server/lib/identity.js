// Athlete identity verification — government/school ID scan + selfie biometric
// (face match + liveness) via STRIPE IDENTITY.
//
// Env-gated exactly like lib/payments.js + routes/billing.js: with no real
// STRIPE_SECRET_KEY the calls DON'T hit Stripe — they SIMULATE a verified result
// so the whole "earn the badge" flow is exercisable in dev (and no real ID is
// ever required). With a real key, Stripe hosts the capture flow, runs the
// document + selfie biometric checks, and we only ever read back the RESULT —
// never the ID image, document number, DOB, or face vector (Stripe holds those).
//
// Data minimization mirrors the card-on-file handling in routes/auth.js: store
// the opaque session id + booleans + a timestamp, nothing sensitive.

import Stripe from 'stripe';

const validStripeKey = (k) => /^sk_(test|live)_[A-Za-z0-9]{20,}$/.test(k || '');

let _stripe = null;
function stripe() {
  if (_stripe) return _stripe;
  if (!validStripeKey(process.env.STRIPE_SECRET_KEY)) return null;
  _stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  return _stripe;
}

// True when a real key is present. When false every function below SIMULATES so
// the product is fully usable in dev (mirrors billing/payments behaviour).
export const identityEnabled = () => validStripeKey(process.env.STRIPE_SECRET_KEY);

const publicOrigin = (req) => (process.env.PUBLIC_URL || process.env.APP_URL || process.env.BASE_URL
  || (req ? `${req.protocol}://${req.get('host')}` : 'http://localhost:5000')).replace(/\/$/, '');

// Map a Stripe VerificationSession status to our idCheckStatus enum.
//   requires_input → the user must (re)submit; surfaces as 'failed' when there's
//   a last_error, otherwise 'pending'. processing → checks running. verified → done.
const mapStatus = (session) => {
  switch (session?.status) {
    case 'verified': return 'verified';
    case 'processing': return 'processing';
    case 'requires_input': return session.last_error ? 'failed' : 'pending';
    default: return 'pending';
  }
};

// Compare two human names loosely (case/whitespace/punctuation-insensitive, token
// subset). Used to cross-check the ID-extracted name against the athlete's profile
// so a real ID belonging to someone else doesn't earn the badge.
const nameMatches = (a, b) => {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
  const an = norm(a), bn = norm(b);
  if (!an.length || !bn.length) return false;
  const setB = new Set(bn);
  const overlap = an.filter(t => setB.has(t)).length;
  return overlap >= Math.min(2, an.length); // first+last (or both tokens) must agree
};

// Start (or resume) an identity verification session for an athlete. Returns a
// hosted URL to redirect to plus the session id. In dev (no key) we fabricate a
// session id + a /?idv=dev return so the status endpoint can auto-approve.
export async function createVerificationSession(user, req) {
  const s = stripe();
  const origin = publicOrigin(req);
  if (!s) {
    return {
      simulated: true,
      id: user.idVerificationId || `vs_dev_${user._id}`,
      url: `${origin}/?idv=dev`
    };
  }
  const session = await s.identity.verificationSessions.create({
    type: 'document',
    metadata: { userId: String(user._id) },
    options: {
      document: {
        require_matching_selfie: true,   // biometric face match against the ID
        require_live_capture: true,      // liveness — block a photo-of-a-photo
        require_id_number: false
      }
    },
    return_url: `${origin}/?idv=done`
  });
  return { simulated: false, id: session.id, url: session.url };
}

// Read back the current state of a session and derive our result fields. Used by
// the status poller and the webhook. In dev (no key / a vs_dev_ id) we report a
// clean 'verified' so the flow completes. Returns:
//   { status, verified, schoolMatch, failureReason, raw }
export async function syncVerificationSession(id, user) {
  const s = stripe();
  if (!s || !id || id.startsWith('vs_dev_')) {
    return { status: 'verified', verified: true, schoolMatch: true, failureReason: '', raw: null };
  }
  // Expand verified_outputs so we can cross-check the extracted name (only the
  // verified-outputs name is read; the ID image/number are never pulled).
  const session = await s.identity.verificationSessions.retrieve(id, {
    expand: ['verified_outputs']
  });
  const status = mapStatus(session);
  const verified = status === 'verified';
  let schoolMatch = false;
  if (verified && session.verified_outputs) {
    const vo = session.verified_outputs;
    const idName = [vo.first_name, vo.last_name].filter(Boolean).join(' ');
    schoolMatch = nameMatches(idName, user?.name);
  }
  // last_error.reason is a stable, user-safe code (e.g. 'document_unverified_other',
  // 'selfie_face_mismatch'); never contains PII.
  const failureReason = status === 'failed' ? (session.last_error?.reason || 'verification_failed') : '';
  return { status, verified, schoolMatch, failureReason, raw: session };
}
