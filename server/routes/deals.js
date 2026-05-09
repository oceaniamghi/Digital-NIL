import express from 'express';
import Deal from '../models/Deal.js';
import Activity from '../models/Activity.js';
import User from '../models/User.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = express.Router();

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
      query = { athlete: req.user._id };
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
      startDate, endDate, campaign, isPublic, featuredImage, athleteId
    } = req.body;

    // Agents must specify an athlete from their roster
    if (req.user.role === 'agent' && athleteId) {
      const agent = await User.findById(req.user._id).select('athletes');
      const inRoster = agent.athletes.some(a => a.toString() === athleteId);
      if (!inRoster) return res.status(403).json({ error: 'Athlete not in your roster' });
    }

    const deal = await Deal.create({
      title, description, type, platforms, sports, minFollowers,
      compensation, deliverables, disclosureTag, expiresAt,
      startDate, endDate, campaign, isPublic, featuredImage,
      brand: req.user._id,
      athlete: athleteId || undefined,
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

// PUT /api/deals/:id/complete — mark deal as completed
router.put('/:id/complete', requireAuth, async (req, res) => {
  try {
    const deal = await Deal.findById(req.params.id);
    if (!deal) return res.status(404).json({ error: 'Deal not found' });
    const isBrand = deal.brand.toString() === req.user._id.toString();
    if (!isBrand) return res.status(403).json({ error: 'Only the brand can complete a deal' });

    deal.status = 'completed';
    await deal.save();

    // Update athlete earnings
    if (deal.athlete) {
      await User.findByIdAndUpdate(deal.athlete, {
        $inc: {
          totalEarnings: deal.compensation.amount,
          dealsCompleted: 1
        }
      });

      await Activity.create({
        user: deal.athlete,
        type: 'payment_received',
        title: 'Payment received',
        message: `$${deal.compensation.amount} earned for: ${deal.title}`,
        relatedDeal: deal._id
      });
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
