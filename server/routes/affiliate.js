import express from 'express';
import User from '../models/User.js';
import Referral from '../models/Referral.js';
import Reward from '../models/Reward.js';
import Redemption from '../models/Redemption.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { ensureReferralCode, redeemReward, CREDITS_PER } from '../lib/affiliate.js';

const router = express.Router();

// Athlete-only affiliate program. Athletes earn referral credits when people they
// refer convert to paid; credits redeem for free paid months (2 athletes = 1 month).
router.use(requireAuth, requireRole('athlete'));

const baseUrl = (req) => (process.env.APP_URL || process.env.BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

// GET /api/affiliate/me — dashboard payload: code, share link, credits, referrals.
router.get('/me', async (req, res) => {
  try {
    const me = await User.findById(req.user._id);
    const code = await ensureReferralCode(me);
    const referrals = await Referral.find({ referrer: me._id })
      .populate('referredUser', 'name avatar role plan')
      .sort({ createdAt: -1 }).limit(200).lean();
    const redemptions = await Redemption.find({ athlete: me._id }).sort({ createdAt: -1 }).limit(50).lean();
    res.json({
      referralCode: code,
      shareLink: `${baseUrl(req)}/?signup=1&ref=${encodeURIComponent(code)}`,
      credits: me.affiliateCredits || 0,
      creditsEarned: me.affiliateCreditsEarned || 0,
      qualifiedReferralCount: me.qualifiedReferralCount || 0,
      pendingCount: referrals.filter(r => r.status === 'pending').length,
      creditsPer: CREDITS_PER,
      comp: { active: !!(me.planComped && me.planCompUntil && me.planCompUntil > new Date()), until: me.planCompUntil || null, plan: me.plan },
      referrals, redemptions
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/affiliate/rewards — active reward catalog.
router.get('/rewards', async (req, res) => {
  try {
    const rewards = await Reward.find({ active: true }).sort({ order: 1, creditsCost: 1 });
    res.json({ rewards });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/affiliate/redeem { key } — spend credits on a reward.
router.post('/redeem', async (req, res) => {
  try {
    const { key } = req.body || {};
    const reward = await Reward.findOne({ key, active: true });
    if (!reward) return res.status(404).json({ error: 'Reward not found' });
    const me = await User.findById(req.user._id);
    const redemption = await redeemReward(me, reward);
    const safe = await User.findById(me._id).select('-password -verifyToken');
    res.json({ ok: true, redemption, user: safe });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

export default router;
