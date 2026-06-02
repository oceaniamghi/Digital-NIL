import express from 'express';
import Deal from '../models/Deal.js';
import Activity from '../models/Activity.js';
import User from '../models/User.js';
import { requireAuth, requireRole, requireCap, upgradeRequired } from '../middleware/auth.js';
import { planLimit, planCan, minPlanForLimit, minPlanForCap, planFeeRate, DEFAULT_FEE_RATE } from '../lib/plans.js';
import { fundDeal, releaseDeal, refundDeal } from '../lib/payments.js';

const router = express.Router();

// The platform fee rate for a deal = the representing agent's tier rate. Resolve it
// from the athlete's agent (the agent who manages this athlete's deals). No athlete
// or no agent → the default rate. Used to stamp Deal.platformFeeRate.
const feeRateForAthlete = async (athleteId) => {
  if (!athleteId) return DEFAULT_FEE_RATE;
  const athlete = await User.findById(athleteId).select('agentId');
  if (!athlete || !athlete.agentId) return DEFAULT_FEE_RATE;
  const agent = await User.findById(athlete.agentId).select('role plan');
  return agent ? planFeeRate(agent) : DEFAULT_FEE_RATE;
};

// GET /api/deals/opportunities — public marketplace for athletes
router.get('/opportunities', requireAuth, async (req, res) => {
  try {
    const { sport, platform, minPay, type, search } = req.query;
    const query = { status: 'open', isPublic: true };
    if (type) query.type = type;
    if (platform) query.platforms = platform;
    if (search) query.title = { $regex: search, $options: 'i' };
    if (sport) query.sports = { $in: [new RegExp(sport, 'i')] };

    let deals = await Deal.find(query)
      .populate('brand', 'name company logo industry avatar')
      .sort({ createdAt: -1 })
      .limit(50);

    if (minPay) {
      const min = parseFloat(minPay);
      deals = deals.filter(d => d.compensation.amount >= min);
    }

    res.json({ deals });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/deals/my-deals — athlete's, brand's, or agent's deals
router.get('/my-deals', requireAuth, async (req, res) => {
  try {
    const { status } = req.query;
    let query;

    if (req.user.role === 'brand') {
      query = { brand: req.user._id };
    } else if (req.user.role === 'agent') {
      const agent = await User.findById(req.user._id).select('athletes');
      query = { athlete: { $in: agent.athletes || [] } };
    } else {
      // Athlete: deals assigned to them OR ones they've applied to (applications
      // don't set deal.athlete until accepted, so include applications.athlete).
      query = { $or: [{ athlete: req.user._id }, { 'applications.athlete': req.user._id }] };
    }

    if (status) query.status = status;

    const deals = await Deal.find(query)
      .populate('brand', 'name company logo avatar agency')
      .populate('athlete', 'name avatar sport school socialHandles')
      .sort({ updatedAt: -1 });

    res.json({ deals });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/deals/saved — athlete's bookmarked opportunities
router.get('/saved', requireAuth, requireRole('athlete'), async (req, res) => {
  try {
    const me = await User.findById(req.user._id)
      .select('savedDeals')
      .populate({ path: 'savedDeals', populate: { path: 'brand', select: 'name company logo avatar' } });
    res.json({ deals: (me.savedDeals || []).filter(Boolean) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/deals/:id
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const deal = await Deal.findById(req.params.id)
      .populate('brand', 'name company logo industry website avatar')
      .populate('athlete', 'name avatar sport school socialHandles')
      .populate('applications.athlete', 'name avatar sport school socialHandles');
    if (!deal) return res.status(404).json({ error: 'Deal not found' });
    res.json({ deal });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/deals — brand or agent creates a deal
router.post('/', requireAuth, requireRole('brand', 'agent'), async (req, res) => {
  try {
    const {
      title, description, type, platforms, sports, minFollowers,
      compensation, deliverables, disclosureTag, expiresAt,
      startDate, endDate, campaign, isPublic, featuredImage, athleteId, recruitmentTrip
    } = req.body;

    // Agents must specify an athlete from their roster
    if (req.user.role === 'agent' && athleteId) {
      const agent = await User.findById(req.user._id).select('athletes');
      const inRoster = agent.athletes.some(a => a.toString() === athleteId);
      if (!inRoster) return res.status(403).json({ error: 'Athlete not in your roster' });
    }

    // Each brand tier caps concurrent live deals (Pro/Elite = unlimited). Agents are
    // unaffected — their ladder gates roster size, not deal volume.
    if (req.user.role === 'brand') {
      const limit = planLimit(req.user, 'deals');
      if (Number.isFinite(limit)) {
        const live = await Deal.countDocuments({
          brand: req.user._id, status: { $in: ['open', 'offered', 'applied', 'active'] }
        });
        if (live >= limit) {
          const min = minPlanForLimit('brand', 'deals', limit + 1);
          return upgradeRequired(req.res || res,
            `Your plan allows ${limit} active deal${limit === 1 ? '' : 's'} at a time. Upgrade${min ? ` to ${min.name}` : ''} for more.`,
            min);
        }
      }
    }

    // Funded recruitment trips are an Elite-only add-on. Honor the flag only when the
    // brand's plan unlocks it; otherwise reject with an upgrade prompt.
    if (recruitmentTrip && recruitmentTrip.included && req.user.role === 'brand' && !planCan(req.user, 'recruitmentTrips')) {
      return upgradeRequired(res, 'Deals with funded recruitment trips are an Elite feature.', minPlanForCap('brand', 'recruitmentTrips'));
    }

    // Stamp the tiered fee rate when the athlete is known (open deals get the agent's
    // tier resolved at completion instead).
    const platformFeeRate = athleteId ? await feeRateForAthlete(athleteId) : undefined;

    const deal = await Deal.create({
      title, description, type, platforms, sports, minFollowers,
      compensation, deliverables, disclosureTag, expiresAt,
      startDate, endDate, campaign, isPublic, featuredImage,
      recruitmentTrip: (recruitmentTrip && recruitmentTrip.included && planCan(req.user, 'recruitmentTrips')) ? recruitmentTrip : undefined,
      brand: req.user._id,
      athlete: athleteId || undefined,
      platformFeeRate,
      status: athleteId ? 'active' : 'open'
    });

    await Activity.create({
      user: req.user._id,
      type: 'deal_offer',
      title: 'New deal posted',
      message: `You posted a new deal: ${title}`,
      relatedDeal: deal._id
    });

    const populated = await deal.populate('brand', 'name company logo avatar');
    res.status(201).json({ deal: populated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/deals/:id — brand edits a deal
router.put('/:id', requireAuth, requireRole('brand', 'agent'), async (req, res) => {
  try {
    const allowed = ['title','description','type','platforms','sports','minFollowers',
      'compensation','deliverables','disclosureTag','expiresAt','startDate','endDate','isPublic','featuredImage'];
    const updates = {};
    for (const k of allowed) { if (req.body[k] !== undefined) updates[k] = req.body[k]; }
    const deal = await Deal.findOneAndUpdate(
      { _id: req.params.id, brand: req.user._id },
      updates, { new: true }
    ).populate('brand','name company logo avatar').populate('athlete','name avatar sport school');
    if (!deal) return res.status(404).json({ error: 'Deal not found' });
    res.json({ deal });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/deals/:id/apply — athlete applies for open deal
router.put('/:id/apply', requireAuth, requireRole('athlete'), async (req, res) => {
  try {
    const deal = await Deal.findById(req.params.id);
    if (!deal) return res.status(404).json({ error: 'Deal not found' });
    if (deal.status !== 'open') return res.status(400).json({ error: 'Deal is not open' });

    const alreadyApplied = deal.applications.some(
      a => a.athlete.toString() === req.user._id.toString()
    );
    if (alreadyApplied) return res.status(409).json({ error: 'Already applied' });

    deal.applications.push({
      athlete: req.user._id,
      message: req.body.message || ''
    });
    deal.status = 'applied';
    await deal.save();

    await Activity.create({
      user: req.user._id,
      type: 'deal_applied',
      title: 'Applied for deal',
      message: `You applied for: ${deal.title}`,
      relatedDeal: deal._id
    });

    // Notify brand
    await Activity.create({
      user: deal.brand,
      type: 'deal_applied',
      title: 'New deal application',
      message: `${req.user.name} applied for: ${deal.title}`,
      relatedDeal: deal._id
    });

    res.json({ deal });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/deals/:id/apply-for — agent applies on behalf of one of their athletes
router.put('/:id/apply-for', requireAuth, requireRole('agent'), async (req, res) => {
  try {
    const { athleteId, message } = req.body;
    if (!athleteId) return res.status(400).json({ error: 'athleteId required' });

    const agent = await User.findById(req.user._id).select('athletes');
    const inRoster = agent.athletes.some(a => a.toString() === athleteId);
    if (!inRoster) return res.status(403).json({ error: 'Athlete not in your roster' });

    const deal = await Deal.findById(req.params.id);
    if (!deal) return res.status(404).json({ error: 'Deal not found' });
    if (deal.status !== 'open') return res.status(400).json({ error: 'Deal is not open' });

    const alreadyApplied = deal.applications.some(a => a.athlete.toString() === athleteId);
    if (alreadyApplied) return res.status(409).json({ error: 'Already applied' });

    deal.applications.push({ athlete: athleteId, message: message || '' });
    deal.status = 'applied';
    await deal.save();

    const athlete = await User.findById(athleteId).select('name');
    await Activity.create({
      user: athleteId,
      type: 'deal_applied',
      title: 'Applied for deal',
      message: `Your agent applied for: ${deal.title}`,
      relatedDeal: deal._id
    });
    await Activity.create({
      user: deal.brand,
      type: 'deal_applied',
      title: 'New deal application',
      message: `${athlete?.name || 'An athlete'} (via agent) applied for: ${deal.title}`,
      relatedDeal: deal._id
    });

    res.json({ deal });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/deals/:id/accept — brand accepts athlete application
router.put('/:id/accept', requireAuth, requireRole('brand'), async (req, res) => {
  try {
    const { athleteId } = req.body;
    const deal = await Deal.findOne({ _id: req.params.id, brand: req.user._id });
    if (!deal) return res.status(404).json({ error: 'Deal not found' });

    const app = deal.applications.find(a => a.athlete.toString() === athleteId);
    if (!app) return res.status(404).json({ error: 'Application not found' });

    app.status = 'accepted';
    deal.athlete = athleteId;
    deal.status = 'active';
    deal.startDate = deal.startDate || new Date();
    await deal.save();

    const athlete = await User.findById(athleteId);

    await Activity.create({
      user: athleteId,
      type: 'deal_accepted',
      title: 'Deal accepted!',
      message: `${req.user.company || req.user.name} accepted your application for: ${deal.title}`,
      relatedDeal: deal._id
    });

    res.json({ deal });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/deals/:id/decline — brand or athlete declines
router.put('/:id/decline', requireAuth, async (req, res) => {
  try {
    const deal = await Deal.findById(req.params.id);
    if (!deal) return res.status(404).json({ error: 'Deal not found' });

    const isBrand = deal.brand.toString() === req.user._id.toString();
    const isAthlete = deal.athlete?.toString() === req.user._id.toString();
    if (!isBrand && !isAthlete) return res.status(403).json({ error: 'Forbidden' });

    // Return escrowed funds to the brand when a funded deal is cancelled.
    if (deal.payment?.status === 'escrowed') {
      try {
        await refundDeal({ deal });
        deal.payment.status = 'refunded';
      } catch { /* leave escrowed; a human can refund from Stripe */ }
    }

    deal.status = 'declined';
    await deal.save();

    await Activity.create({
      user: req.user._id,
      type: 'deal_declined',
      title: 'Deal declined',
      message: `Deal declined: ${deal.title}`,
      relatedDeal: deal._id
    });

    res.json({ deal });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/deals/:id/fund — brand funds the deal into escrow (Stripe Connect). The
// deal must be the brand's and accepted (offered/active). With real Stripe this
// returns a Checkout URL; in dev it escrows instantly so the flow is testable.
router.post('/:id/fund', requireAuth, requireRole('brand'), async (req, res) => {
  try {
    const deal = await Deal.findById(req.params.id);
    if (!deal) return res.status(404).json({ error: 'Deal not found' });
    if (deal.brand.toString() !== req.user._id.toString()) return res.status(403).json({ error: 'Not your deal' });
    if (!['offered', 'active'].includes(deal.status)) {
      return res.status(400).json({ error: 'Only an accepted (active) deal can be funded.' });
    }
    if (['escrowed', 'released'].includes(deal.payment?.status)) {
      return res.status(409).json({ error: 'This deal is already funded.' });
    }
    const result = await fundDeal({ deal, brand: req.user, req });
    if (result.url) {
      deal.payment.status = 'funding';
      await deal.save();
      return res.json({ url: result.url });
    }
    // Simulated (dev): escrow immediately.
    deal.payment = {
      ...deal.payment.toObject?.() || deal.payment,
      status: 'escrowed', intentId: result.intentId, amount: result.amount,
      simulated: true, fundedAt: new Date()
    };
    await deal.save();
    await Activity.create({
      user: deal.brand, type: 'campaign_launched',
      title: 'Deal funded (escrow)', message: `$${result.amount} held in escrow for: ${deal.title}`,
      relatedDeal: deal._id
    }).catch(() => {});
    res.json({ deal, escrowed: true, simulated: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/deals/:id/complete — mark deal as completed
router.put('/:id/complete', requireAuth, async (req, res) => {
  try {
    const deal = await Deal.findById(req.params.id);
    if (!deal) return res.status(404).json({ error: 'Deal not found' });
    const isBrand = deal.brand.toString() === req.user._id.toString();
    if (!isBrand) return res.status(403).json({ error: 'Only the brand can complete a deal' });

    // Finalize the fee rate against the representing agent's CURRENT tier, so the
    // payout reflects the plan they actually hold at close (fair for open deals that
    // were created before an athlete/agent was bound).
    deal.platformFeeRate = await feeRateForAthlete(deal.athlete);
    deal.status = 'completed';

    // Update athlete earnings — net of the platform service fee (the athlete is paid
    // the gross minus Digital NIL's commission).
    if (deal.athlete) {
      const net = deal.athleteNet;        // virtual: gross − platform fee
      const fee = deal.platformFee;

      // Release escrowed funds to the athlete's connected account (real payout, or a
      // dev simulation). Only attempts when the brand actually funded the escrow;
      // unfunded deals still record earnings so legacy/manual deals keep working.
      if (deal.payment?.status === 'escrowed') {
        const athlete = await User.findById(deal.athlete).select('name email stripeAccountId payoutsEnabled');
        try {
          const r = await releaseDeal({ deal, athlete });
          deal.payment.status = 'released';
          deal.payment.transferId = r.transferId;
          deal.payment.fee = r.fee;
          deal.payment.net = r.net;
          deal.payment.releasedAt = new Date();
        } catch (e) {
          // Athlete hasn't onboarded payouts — keep funds in escrow, surface the reason.
          await deal.save();
          return res.status(409).json({ error: `Payout blocked: ${e.message}`, needsPayoutOnboarding: true });
        }
      }

      await deal.save();
      await User.findByIdAndUpdate(deal.athlete, {
        $inc: {
          totalEarnings: net,
          dealsCompleted: 1
        }
      });

      await Activity.create({
        user: deal.athlete,
        type: 'payment_received',
        title: 'Payment received',
        message: `$${net} earned for: ${deal.title} (after $${fee} platform fee)`,
        relatedDeal: deal._id
      });
    } else {
      await deal.save();
    }

    await Activity.create({
      user: req.user._id,
      type: 'deal_completed',
      title: 'Deal completed',
      message: `Deal completed: ${deal.title}`,
      relatedDeal: deal._id
    });

    res.json({ deal });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/deals/:id/metrics — update deal performance metrics
router.put('/:id/metrics', requireAuth, async (req, res) => {
  try {
    const deal = await Deal.findById(req.params.id);
    if (!deal) return res.status(404).json({ error: 'Deal not found' });

    const { impressions, clicks, engagements, reach } = req.body;
    deal.metrics = { impressions, clicks, engagements, reach };
    await deal.save();
    res.json({ deal });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/deals/:id/save — athlete bookmarks an opportunity ($addToSet = dedup)
router.put('/:id/save', requireAuth, requireRole('athlete'), async (req, res) => {
  try {
    const deal = await Deal.findById(req.params.id).select('_id');
    if (!deal) return res.status(404).json({ error: 'Deal not found' });
    await User.findByIdAndUpdate(req.user._id, { $addToSet: { savedDeals: deal._id } });
    res.json({ saved: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/deals/:id/save — athlete removes a bookmark
router.delete('/:id/save', requireAuth, requireRole('athlete'), async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.user._id, { $pull: { savedDeals: req.params.id } });
    res.json({ saved: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/deals/offer — brand sends a direct offer to a specific athlete.
// Direct offers require a plan tier with the `directOffers` capability (Starter+).
router.post('/offer', requireAuth, requireRole('brand'), requireCap('directOffers', 'Sending direct offers to athletes'), async (req, res) => {
  try {
    const { athleteId, title, description, compensation, deliverables, platforms, offerMessage, recruitmentTrip } = req.body;
    if (!athleteId) return res.status(400).json({ error: 'athleteId required' });
    if (!title) return res.status(400).json({ error: 'title required' });
    if (!compensation?.amount) return res.status(400).json({ error: 'compensation amount required' });

    const athlete = await User.findOne({ _id: athleteId, role: 'athlete' }).select('name');
    if (!athlete) return res.status(404).json({ error: 'Athlete not found' });

    if (recruitmentTrip && recruitmentTrip.included && !planCan(req.user, 'recruitmentTrips')) {
      return upgradeRequired(res, 'Deals with funded recruitment trips are an Elite feature.', minPlanForCap('brand', 'recruitmentTrips'));
    }

    // Dedup: one live offer/active deal per brand+athlete at a time.
    const existing = await Deal.findOne({
      brand: req.user._id, athlete: athleteId, status: { $in: ['offered', 'active'] }
    });
    if (existing) return res.status(409).json({ error: 'You already have an active offer with this athlete' });

    const deal = await Deal.create({
      title,
      description: description || `Offer from ${req.user.company || req.user.name}`,
      brand: req.user._id,
      athlete: athleteId,
      platforms: platforms || [],
      compensation,
      deliverables: deliverables || [],
      offerMessage: offerMessage || '',
      recruitmentTrip: (recruitmentTrip && recruitmentTrip.included && planCan(req.user, 'recruitmentTrips')) ? recruitmentTrip : undefined,
      platformFeeRate: await feeRateForAthlete(athleteId),
      status: 'offered',
      isPublic: false
    });

    await Activity.create({
      user: athleteId,
      type: 'deal_offer',
      title: 'New deal offer',
      message: `${req.user.company || req.user.name} sent you an offer: ${title}`,
      relatedDeal: deal._id
    });

    const populated = await deal.populate('brand', 'name company logo avatar');
    res.status(201).json({ deal: populated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/deals/:id/accept-offer — athlete accepts a brand's direct offer
router.put('/:id/accept-offer', requireAuth, requireRole('athlete'), async (req, res) => {
  try {
    const deal = await Deal.findById(req.params.id);
    if (!deal) return res.status(404).json({ error: 'Deal not found' });
    if (deal.status !== 'offered' || deal.athlete?.toString() !== req.user._id.toString()) {
      return res.status(400).json({ error: 'No pending offer to accept' });
    }
    deal.status = 'active';
    deal.startDate = deal.startDate || new Date();
    await deal.save();

    await Activity.create({
      user: deal.brand,
      type: 'deal_accepted',
      title: 'Offer accepted!',
      message: `${req.user.name} accepted your offer: ${deal.title}`,
      relatedDeal: deal._id
    });

    res.json({ deal });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/deals/:id — brand deletes an open deal
router.delete('/:id', requireAuth, requireRole('brand'), async (req, res) => {
  try {
    const deal = await Deal.findOneAndDelete({ _id: req.params.id, brand: req.user._id, status: 'open' });
    if (!deal) return res.status(404).json({ error: 'Deal not found or cannot be deleted' });
    res.json({ message: 'Deal deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
