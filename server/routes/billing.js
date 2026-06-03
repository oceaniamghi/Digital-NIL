import express from 'express';
import Stripe from 'stripe';
import User from '../models/User.js';
import Deal from '../models/Deal.js';
import Activity from '../models/Activity.js';
import { requireAuth } from '../middleware/auth.js';
import { planFor, isValidPlan, isPaidPlan, serializePlans, plansForRole } from '../lib/plans.js';
import { qualifyReferral } from '../lib/affiliate.js';
import { createPayoutOnboarding, payoutStatus } from '../lib/payments.js';
import { syncVerificationSession } from '../lib/identity.js';

const router = express.Router();
const IS_PROD = process.env.NODE_ENV === 'production';

// One-time account sign-up fee (USD). Charged once per athlete/brand before go-live;
// agents start free (see onboarding copy). Tracked on User.signupFeePaid.
const SIGNUP_FEE = 99;
const owesSignupFee = (role) => role === 'athlete' || role === 'brand';

// Behind Railway's TLS proxy req.protocol is unreliable, so prefer an explicit
// public URL env for Stripe redirect targets, falling back to the request origin.
const publicOrigin = (req) => (process.env.PUBLIC_URL || process.env.APP_URL || process.env.BASE_URL
  || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

// A real Stripe secret key is `sk_test_`/`sk_live_` + a long alphanumeric token.
// Reject placeholders (e.g. "sk_test_...-key") so a stubbed .env doesn't make the
// app think billing is live and attempt a charge with a bogus key.
const validStripeKey = k => /^sk_(test|live)_[A-Za-z0-9]{20,}$/.test(k || '');

// Lazily construct the Stripe client so a missing key never crashes boot — the
// endpoints degrade gracefully (dev grant), matching the CFBD/owner-key pattern.
let _stripe = null;
function stripe() {
  if (_stripe) return _stripe;
  if (!validStripeKey(process.env.STRIPE_SECRET_KEY)) return null;
  _stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  return _stripe;
}
const billingEnabled = () => validStripeKey(process.env.STRIPE_SECRET_KEY);

// Apply a tier to a user. Validated against the user's role ladder so a webhook (or
// dev grant) can never assign a plan that doesn't exist for that role.
async function grantPlan(userId, plan, extra = {}) {
  const user = await User.findById(userId);
  if (!user) return null;
  if (!isValidPlan(user.role, plan)) return null;
  user.plan = plan;
  user.planSince = isPaidPlan(user.role, plan) ? new Date() : null;
  if (extra.stripeCustomerId) user.stripeCustomerId = extra.stripeCustomerId;
  if (extra.stripeSubscriptionId) user.stripeSubscriptionId = extra.stripeSubscriptionId;
  await user.save();
  // Pay out a referral when a referred user converts to a paid plan (idempotent).
  if (isPaidPlan(user.role, plan)) qualifyReferral(user).catch(() => {});
  return user;
}

// GET /api/billing/config — everything the client needs to render pricing + decide
// the checkout flow (real Stripe redirect vs. dev instant-grant). Plans are the
// server's source of truth (unlimited limits encoded as null for valid JSON).
router.get('/config', (req, res) => {
  res.json({
    enabled: billingEnabled(),
    devGrant: !billingEnabled() && !IS_PROD,
    feeRate: 0.20,
    plans: serializePlans()
  });
});

// POST /api/billing/checkout { plan } — start a subscription checkout for the
// logged-in user's role + chosen tier. Returns { url } to redirect to. With no
// Stripe key in dev it grants the plan immediately and returns { granted, user }.
router.post('/checkout', requireAuth, async (req, res) => {
  try {
    const { plan } = req.body || {};
    const role = req.user.role;
    if (!plansForRole(role).length) return res.status(400).json({ error: 'Your role has no subscription plans' });
    if (!isValidPlan(role, plan) || !isPaidPlan(role, plan)) {
      return res.status(400).json({ error: 'Unknown or non-paid plan' });
    }
    const tier = planFor(role, plan);

    if (!billingEnabled()) {
      if (IS_PROD) {
        return res.status(503).json({ error: 'Checkout is not configured. Set STRIPE_SECRET_KEY to enable subscriptions.' });
      }
      const user = await grantPlan(req.user._id, plan);
      return res.json({ granted: true, dev: true, user });
    }

    const origin = publicOrigin(req);
    const metadata = { userId: String(req.user._id), role, plan };
    const session = await stripe().checkout.sessions.create({
      mode: 'subscription',
      customer_email: req.user.email,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: tier.price * 100,
          recurring: { interval: 'month' },
          product_data: { name: `Digital NIL — ${tier.name} (${role})`, description: tier.tagline || '' }
        }
      }],
      metadata,
      subscription_data: { metadata },   // echoed on subscription.* webhooks too
      success_url: `${origin}/?upgrade=success&plan=${plan}`,
      cancel_url: `${origin}/?upgrade=cancel`
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/billing/cancel — drop back to the free tier. Cancels the live Stripe
// subscription too when one is on file (best-effort; the webhook also handles it).
router.post('/cancel', requireAuth, async (req, res) => {
  try {
    const s = stripe();
    if (s && req.user.stripeSubscriptionId) {
      try { await s.subscriptions.cancel(req.user.stripeSubscriptionId); } catch { /* already gone */ }
    }
    const user = await User.findByIdAndUpdate(
      req.user._id,
      { plan: 'free', planSince: null, stripeSubscriptionId: '' },
      { new: true }
    ).select('-password');
    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/billing/signup-fee — one-time $99 account sign-up charge for athletes/
// brands. Returns { url } to redirect to Stripe Checkout. No-ops if already paid or
// the role owes no fee; dev (no Stripe key) grants it instantly like /checkout does.
router.post('/signup-fee', requireAuth, async (req, res) => {
  try {
    if (!owesSignupFee(req.user.role)) {
      return res.status(400).json({ error: 'Your role has no sign-up fee.' });
    }
    if (req.user.signupFeePaid) return res.json({ alreadyPaid: true });

    if (!billingEnabled()) {
      if (IS_PROD) {
        return res.status(503).json({ error: 'Payments are not configured. Set STRIPE_SECRET_KEY to collect the sign-up fee.' });
      }
      const user = await User.findByIdAndUpdate(
        req.user._id, { signupFeePaid: true }, { new: true }
      ).select('-password');
      qualifyReferral(user).catch(() => {});
      return res.json({ granted: true, dev: true, user });
    }

    const origin = publicOrigin(req);
    const metadata = { userId: String(req.user._id), kind: 'signup_fee' };
    const session = await stripe().checkout.sessions.create({
      mode: 'payment',
      customer_email: req.user.email,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: SIGNUP_FEE * 100,
          product_data: { name: 'Digital NIL — Account sign-up fee' }
        }
      }],
      metadata,
      payment_intent_data: { metadata },   // echoed on payment_intent.* webhooks too
      success_url: `${origin}/?signup_fee=success`,
      cancel_url: `${origin}/?signup_fee=cancel`
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/billing/connect — start/resume Stripe Connect payout onboarding for the
// logged-in user (athletes & agents receive deal payouts). Returns { url } to redirect
// to, or { simulated } in dev where payouts are auto-enabled.
router.post('/connect', requireAuth, async (req, res) => {
  try {
    if (!['athlete', 'agent'].includes(req.user.role)) {
      return res.status(400).json({ error: 'Only athletes and agents receive payouts.' });
    }
    const result = await createPayoutOnboarding(req.user, req);
    const updates = { stripeAccountId: result.accountId };
    if (result.payoutsEnabled) updates.payoutsEnabled = true;
    await User.findByIdAndUpdate(req.user._id, updates);
    res.json({ url: result.url, simulated: !!result.simulated, payoutsEnabled: !!result.payoutsEnabled });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/billing/connect/status — refresh + report whether payouts are live.
router.get('/connect/status', requireAuth, async (req, res) => {
  try {
    const { payoutsEnabled, simulated } = await payoutStatus(req.user);
    if (payoutsEnabled && !req.user.payoutsEnabled) {
      await User.findByIdAndUpdate(req.user._id, { payoutsEnabled: true });
    }
    res.json({ payoutsEnabled, simulated, onboarded: !!req.user.stripeAccountId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/billing/tax/1099?year=YYYY — a 1099-style payout summary. Athletes get
// their own; admins can pass ?athleteId= for any athlete. Sums released escrow payouts.
router.get('/tax/1099', requireAuth, async (req, res) => {
  try {
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const start = new Date(year, 0, 1), end = new Date(year + 1, 0, 1);
    let athleteId = req.user._id;
    if (req.user.role === 'admin' && req.query.athleteId) athleteId = req.query.athleteId;
    else if (!['athlete'].includes(req.user.role)) return res.status(403).json({ error: 'No payout records for this role.' });

    const deals = await Deal.find({
      athlete: athleteId, 'payment.status': 'released',
      'payment.releasedAt': { $gte: start, $lt: end }
    }).populate('brand', 'name company').select('title brand payment compensation').lean();

    const gross = deals.reduce((s, d) => s + (d.payment?.amount || d.compensation?.amount || 0), 0);
    const fees = deals.reduce((s, d) => s + (d.payment?.fee || 0), 0);
    const net = deals.reduce((s, d) => s + (d.payment?.net || 0), 0);
    res.json({
      year, count: deals.length, gross, fees, net,
      lines: deals.map(d => ({
        deal: d.title, payer: d.brand?.company || d.brand?.name || '—',
        gross: d.payment?.amount || d.compensation?.amount || 0, fee: d.payment?.fee || 0, net: d.payment?.net || 0
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/billing/webhook — Stripe calls this on payment events. Mounted with a
// raw body (see index.js) so the signature can be verified. Subscriptions are kept
// in sync: checkout completion grants the plan; cancellation reverts to free.
router.post('/webhook', async (req, res) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const s = stripe();
  if (!s || !secret) return res.status(503).json({ error: 'Webhook not configured' });
  let event;
  try {
    event = s.webhooks.constructEvent(req.rawBody, req.headers['stripe-signature'], secret);
  } catch (err) {
    return res.status(400).json({ error: `Webhook signature verification failed: ${err.message}` });
  }
  try {
    if (event.type === 'checkout.session.completed') {
      const sess = event.data.object;
      const m = sess.metadata || {};
      if (m.kind === 'deal_escrow' && m.dealId) {
        // Brand finished funding a deal into escrow.
        const deal = await Deal.findById(m.dealId);
        if (deal && deal.payment?.status !== 'released') {
          deal.payment.status = 'escrowed';
          deal.payment.intentId = sess.payment_intent || deal.payment.intentId;
          deal.payment.amount = (sess.amount_total || 0) / 100 || deal.compensation?.amount || 0;
          deal.payment.fundedAt = new Date();
          await deal.save();
          await Activity.create({
            user: deal.brand, type: 'campaign_launched',
            title: 'Deal funded (escrow)', message: `Escrow funded for: ${deal.title}`,
            relatedDeal: deal._id
          }).catch(() => {});
        }
      } else if (m.kind === 'signup_fee' && m.userId) {
        const user = await User.findByIdAndUpdate(m.userId, { signupFeePaid: true }, { new: true });
        if (user) qualifyReferral(user).catch(() => {});
        if (user) {
          await Activity.create({
            user: user._id, type: 'campaign_launched',
            title: 'Sign-up fee paid', message: 'Your account is fully activated.'
          }).catch(() => {});
        }
      } else if (m.userId && m.plan) {
        const user = await grantPlan(m.userId, m.plan, {
          stripeCustomerId: sess.customer, stripeSubscriptionId: sess.subscription
        });
        if (user) {
          await Activity.create({
            user: user._id, type: 'campaign_launched',
            title: `Upgraded to ${planFor(user.role, user.plan).name}`,
            message: 'Your new plan features are now unlocked.'
          }).catch(() => {});
        }
      }
    } else if (event.type && event.type.startsWith('identity.verification_session.')) {
      // Athlete ID + selfie biometric finished (often on their phone, async). Sync
      // the result onto the user and flip the verified badge. The session carries
      // our userId in metadata; fall back to matching the stored session id.
      const session = event.data.object;
      const userId = session.metadata?.userId;
      const user = userId
        ? await User.findById(userId)
        : await User.findOne({ idVerificationId: session.id });
      if (user) {
        const result = await syncVerificationSession(session.id, user).catch(() => null);
        if (result) {
          const wasVerified = user.identityVerified;
          user.idCheckStatus = result.status;
          if (result.status === 'verified') {
            user.identityVerified = true;
            user.idVerifiedAt = user.idVerifiedAt || new Date();
            user.idCheckSchoolMatch = !!result.schoolMatch;
            user.idFailureReason = '';
          } else if (result.status === 'failed') {
            user.idFailureReason = result.failureReason || 'verification_failed';
          }
          await user.save();
          if (!wasVerified && user.identityVerified) {
            await Activity.create({
              user: user._id, type: 'profile_verified',
              title: 'Identity verified', message: 'Your athlete identity is verified — your badge is live.'
            }).catch(() => {});
          }
        }
      }
    } else if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const user = await User.findOne({ stripeSubscriptionId: sub.id });
      if (user) { user.plan = 'free'; user.planSince = null; user.stripeSubscriptionId = ''; await user.save(); }
    } else if (event.type === 'customer.subscription.updated') {
      // Honor a plan change carried in subscription metadata (e.g. portal upgrade).
      const sub = event.data.object;
      const m = sub.metadata || {};
      if (m.userId && m.plan) await grantPlan(m.userId, m.plan, { stripeSubscriptionId: sub.id });
    }
    res.json({ received: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
