import crypto from 'crypto';
import User from '../models/User.js';
import Referral from '../models/Referral.js';
import Reward from '../models/Reward.js';
import Redemption from '../models/Redemption.js';
import Activity from '../models/Activity.js';
import { isPaidPlan } from './plans.js';

// ── Athlete affiliate / referral engine ───────────────────────────────────────
// Athletes earn referral CREDITS when someone they refer converts to PAID. Credits
// redeem for free paid months. Rule: 2 referred athletes = 1 free month.
//   athlete referral = 1 credit, coach referral = 2 credits (coaches are scarcer).
// Only athletes can be referrers (the program is athlete-facing); only athlete/coach
// signups qualify as referred targets.

export const CREDITS_PER = { athlete: 1, coach: 2 };
export const ELIGIBLE_REFERRED_ROLES = ['athlete', 'coach'];
// Athlete tier granted free while a comp is active (if the athlete is on Free). The
// "popular" mainstream tier so the perk feels premium. If already on a paid plan we
// keep their current plan and just extend the comp window.
export const COMP_TIER = 'plus';
const DAY = 86400000;

// A short, unambiguous share code (no easily-confused chars). Unique per athlete.
export async function ensureReferralCode(user) {
  if (user.referralCode) return user.referralCode;
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const base = (user.name || 'DNIL').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4) || 'DNIL';
  for (let i = 0; i < 8; i++) {
    const rand = Array.from(crypto.randomBytes(4)).map(b => alphabet[b % alphabet.length]).join('');
    const code = `${base}-${rand}`;
    if (!(await User.exists({ referralCode: code }))) {
      user.referralCode = code;
      await user.save();
      return code;
    }
  }
  // Fallback: hex of the id (always unique).
  user.referralCode = 'DNIL-' + String(user._id).slice(-6).toUpperCase();
  await user.save();
  return user.referralCode;
}

// Attach a new signup to their referrer. Called from register AFTER the user exists.
// Silently no-ops on a bad/self/duplicate code so signup never fails on referral.
export async function recordReferral(newUser, code) {
  try {
    if (!code || !newUser) return null;
    if (!ELIGIBLE_REFERRED_ROLES.includes(newUser.role)) return null;
    const referrer = await User.findOne({ referralCode: String(code).trim().toUpperCase() });
    if (!referrer || referrer.role !== 'athlete') return null;          // only athletes refer
    if (String(referrer._id) === String(newUser._id)) return null;       // no self-referral
    if (newUser.referredBy) return null;                                 // already attributed
    if (await Referral.exists({ referredUser: newUser._id })) return null;

    newUser.referredBy = referrer._id;
    await newUser.save();
    return await Referral.create({
      referrer: referrer._id, referredUser: newUser._id,
      referredRole: newUser.role, status: 'pending'
    });
  } catch { return null; }
}

// Pay out a referral once its referred user converts to PAID (plan or sign-up fee).
// Idempotent via user.referralQualified. Awards credits to the referrer by the
// referred user's role and notifies them. Pass a fresh user doc or id.
export async function qualifyReferral(userOrId) {
  try {
    const user = typeof userOrId === 'object' && userOrId._id ? userOrId : await User.findById(userOrId);
    if (!user || !user.referredBy || user.referralQualified) return null;

    const ref = await Referral.findOne({ referredUser: user._id, status: 'pending' });
    user.referralQualified = true;
    await user.save();
    if (!ref) return null;

    const credits = CREDITS_PER[ref.referredRole] || 1;
    ref.status = 'qualified';
    ref.creditsAwarded = credits;
    ref.qualifiedAt = new Date();
    await ref.save();

    const referrer = await User.findByIdAndUpdate(ref.referrer, {
      $inc: { affiliateCredits: credits, affiliateCreditsEarned: credits, qualifiedReferralCount: 1 }
    }, { new: true });

    if (referrer) {
      await Activity.create({
        user: referrer._id, type: 'social_connected',
        title: `+${credits} referral credit${credits > 1 ? 's' : ''}`,
        message: `${user.name} upgraded — you earned ${credits} credit${credits > 1 ? 's' : ''}. 2 = a free month.`
      }).catch(() => {});
    }
    return ref;
  } catch { return null; }
}

// Redeem an active reward for credits. free_month rewards auto-apply by extending
// the athlete's comp window (and granting the comp tier if they're on Free).
export async function redeemReward(athlete, reward) {
  if (!reward || !reward.active) { const e = new Error('That reward is not available.'); e.status = 400; throw e; }
  if ((athlete.affiliateCredits || 0) < reward.creditsCost) {
    const e = new Error(`You need ${reward.creditsCost} credits (you have ${athlete.affiliateCredits || 0}). Refer 2 athletes to earn a free month.`);
    e.status = 402; throw e;
  }

  athlete.affiliateCredits -= reward.creditsCost;

  let compUntil = athlete.planCompUntil && athlete.planCompUntil > new Date() ? new Date(athlete.planCompUntil) : new Date();
  if (reward.type === 'free_month') {
    compUntil = new Date(compUntil.getTime() + (reward.months || 1) * 30 * DAY);
    athlete.planCompUntil = compUntil;
    athlete.planComped = true;
    // If on Free, grant the comp tier for the window; if already paid, keep their plan.
    if (!isPaidPlan(athlete.role, athlete.plan)) {
      athlete.plan = COMP_TIER;
      athlete.planSince = new Date();
    }
  }
  await athlete.save();

  const redemption = await Redemption.create({
    athlete: athlete._id, reward: reward._id, rewardName: reward.name, type: reward.type,
    creditsSpent: reward.creditsCost, monthsGranted: reward.type === 'free_month' ? (reward.months || 1) : 0,
    compUntil: reward.type === 'free_month' ? compUntil : undefined,
    status: reward.type === 'free_month' ? 'applied' : 'pending_fulfillment'
  });
  await Activity.create({
    user: athlete._id, type: 'campaign_launched', title: `Redeemed: ${reward.name}`,
    message: reward.type === 'free_month' ? `Free until ${compUntil.toISOString().slice(0, 10)}.` : 'Your reward is being processed.'
  }).catch(() => {});
  return redemption;
}

// Auto-revert an expired comp. Called cheaply in requireAuth (only when comped).
export async function applyCompExpiry(user) {
  if (user && user.planComped && user.planCompUntil && user.planCompUntil < new Date()) {
    user.plan = 'free';
    user.planComped = false;
    user.planCompUntil = null;
    await user.save();
  }
  return user;
}

// Idempotent reward-catalog seed (free months only, per the chosen fulfillment).
export async function seedRewards() {
  const exists = await Reward.countDocuments();
  if (exists > 0) return 0;
  const rewards = [
    { key: 'free_month_1', name: '1 Free Month', description: 'One month of your paid plan, free. (Refer 2 athletes.)', type: 'free_month', creditsCost: 2, months: 1, order: 1 },
    { key: 'free_month_3', name: '3 Free Months', description: 'A full season on us.', type: 'free_month', creditsCost: 5, months: 3, order: 2 },
    { key: 'free_month_6', name: '6 Free Months', description: 'Half a year free — for top recruiters.', type: 'free_month', creditsCost: 9, months: 6, order: 3 }
  ];
  await Reward.insertMany(rewards);
  return rewards.length;
}
