// Stripe Connect deal payments — escrow + payout rails on top of the Deal fee math.
//
// Model: SEPARATE CHARGES AND TRANSFERS.
//   1. fund()    — the brand is charged the gross deal amount; funds sit in the
//                  platform balance ("escrow").
//   2. release() — on deal completion the athlete's NET (gross − platform fee) is
//                  transferred to their connected account; the platform keeps the fee.
//   3. refund()  — a declined/abandoned escrowed deal returns the gross to the brand.
//
// Env-gated exactly like lib/resend.js + routes/billing.js: with no real
// STRIPE_SECRET_KEY the calls DON'T hit Stripe — they return a simulated result so
// the whole escrow→payout flow is exercisable in dev (and never charges anyone).
// Athletes onboard a payout account via createPayoutOnboarding(); until then a deal
// can be funded (escrowed) but not released.

import Stripe from 'stripe';
import { platformFeeOn, athleteNetOf, PLATFORM_FEE_RATE } from '../models/Deal.js';

const validStripeKey = (k) => /^sk_(test|live)_[A-Za-z0-9]{20,}$/.test(k || '');

let _stripe = null;
function stripe() {
  if (_stripe) return _stripe;
  if (!validStripeKey(process.env.STRIPE_SECRET_KEY)) return null;
  _stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  return _stripe;
}

// True when a real key is present. When false every function below SIMULATES so the
// product is fully usable in dev (mirrors billing's devGrant behaviour).
export const paymentsEnabled = () => validStripeKey(process.env.STRIPE_SECRET_KEY);

const publicOrigin = (req) => (process.env.PUBLIC_URL || process.env.APP_URL || process.env.BASE_URL
  || (req ? `${req.protocol}://${req.get('host')}` : 'http://localhost:5000')).replace(/\/$/, '');

// Start (or resume) Stripe Connect Express onboarding for an athlete so they can
// receive payouts. Returns an account-link URL to redirect to. In dev (no key) we
// fabricate an account id + mark payouts enabled so release() can be tested.
export async function createPayoutOnboarding(user, req) {
  const s = stripe();
  if (!s) {
    return { simulated: true, accountId: user.stripeAccountId || `acct_dev_${user._id}`, payoutsEnabled: true, url: `${publicOrigin(req)}/?payouts=dev` };
  }
  let accountId = user.stripeAccountId;
  if (!accountId) {
    const acct = await s.accounts.create({
      type: 'express', email: user.email,
      capabilities: { transfers: { requested: true } },
      business_type: 'individual',
      metadata: { userId: String(user._id) }
    });
    accountId = acct.id;
  }
  const origin = publicOrigin(req);
  const link = await s.accountLinks.create({
    account: accountId,
    refresh_url: `${origin}/?payouts=refresh`,
    return_url: `${origin}/?payouts=done`,
    type: 'account_onboarding'
  });
  return { simulated: false, accountId, payoutsEnabled: false, url: link.url };
}

// Whether an athlete's connected account can actually receive transfers yet.
export async function payoutStatus(user) {
  const s = stripe();
  if (!s) return { payoutsEnabled: !!user.stripeAccountId || true, simulated: true };
  if (!user.stripeAccountId) return { payoutsEnabled: false, simulated: false };
  const acct = await s.accounts.retrieve(user.stripeAccountId);
  return { payoutsEnabled: !!acct.payouts_enabled && !!acct.charges_enabled, simulated: false };
}

// Charge the brand the gross amount into platform escrow. `brand` may carry a
// stripeCustomerId; if absent Stripe will use customer_email at checkout. Returns
// a Checkout Session URL (real) or a simulated escrow result (dev).
export async function fundDeal({ deal, brand, req }) {
  const gross = Number(deal.compensation?.amount) || 0;
  if (gross <= 0) throw new Error('Deal has no compensation amount to fund');
  const s = stripe();
  if (!s) {
    return { simulated: true, status: 'escrowed', intentId: `pi_dev_${deal._id}`, amount: gross };
  }
  const origin = publicOrigin(req);
  const metadata = { dealId: String(deal._id), kind: 'deal_escrow', brandId: String(brand._id) };
  const session = await s.checkout.sessions.create({
    mode: 'payment',
    customer_email: brand.email,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: deal.compensation?.currency?.toLowerCase() || 'usd',
        unit_amount: gross * 100,
        product_data: { name: `Digital NIL escrow — ${deal.title}` }
      }
    }],
    metadata,
    payment_intent_data: { metadata, capture_method: 'automatic' },
    success_url: `${origin}/?deal_funded=${deal._id}`,
    cancel_url: `${origin}/?deal_fund_cancel=${deal._id}`
  });
  return { simulated: false, status: 'funding', url: session.url };
}

// Release escrowed funds: transfer the athlete NET to their connected account; the
// platform retains the fee. Requires the athlete to have completed payout onboarding.
export async function releaseDeal({ deal, athlete }) {
  const gross = Number(deal.compensation?.amount) || 0;
  const rate = deal.platformFeeRate ?? PLATFORM_FEE_RATE;
  const fee = platformFeeOn(gross, rate);
  const net = athleteNetOf(gross, rate);
  const s = stripe();
  if (!s) {
    return { simulated: true, status: 'released', transferId: `tr_dev_${deal._id}`, fee, net };
  }
  if (!athlete?.stripeAccountId) throw new Error('Athlete has not completed payout onboarding');
  const transfer = await s.transfers.create({
    amount: net * 100,
    currency: deal.compensation?.currency?.toLowerCase() || 'usd',
    destination: athlete.stripeAccountId,
    metadata: { dealId: String(deal._id), kind: 'deal_payout' }
  });
  return { simulated: false, status: 'released', transferId: transfer.id, fee, net };
}

// Refund an escrowed deal back to the brand (declined/abandoned).
export async function refundDeal({ deal }) {
  const s = stripe();
  if (!s) return { simulated: true, status: 'refunded' };
  if (deal.payment?.intentId && !String(deal.payment.intentId).startsWith('pi_dev_')) {
    await s.refunds.create({ payment_intent: deal.payment.intentId });
  }
  return { simulated: false, status: 'refunded' };
}
