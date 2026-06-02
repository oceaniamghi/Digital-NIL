import express from 'express';
import Stripe from 'stripe';
import User from '../models/User.js';
import Activity from '../models/Activity.js';
import { requireAuth } from '../middleware/auth.js';
import { planFor, isValidPlan, isPaidPlan, serializePlans, plansForRole } from '../lib/plans.js';

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
      if (m.kind === 'signup_fee' && m.userId) {
        const user = await User.findByIdAndUpdate(m.userId, { signupFeePaid: true }, { new: true });
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
