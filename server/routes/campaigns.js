import express from 'express';
import Campaign from '../models/Campaign.js';
import Deal from '../models/Deal.js';
import Activity from '../models/Activity.js';
import { requireAuth, requireRole, upgradeRequired } from '../middleware/auth.js';
import { planLimit, minPlanForLimit } from '../lib/plans.js';

const router = express.Router();

// GET /api/campaigns
router.get('/', requireAuth, requireRole('brand'), async (req, res) => {
  try {
    const { status } = req.query;
    const query = { brand: req.user._id };
    if (status) query.status = status;
    const campaigns = await Campaign.find(query).sort({ createdAt: -1 });
    res.json({ campaigns });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/campaigns/:id
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const campaign = await Campaign.findById(req.params.id)
      .populate({
        path: 'deals',
        populate: { path: 'athlete', select: 'name avatar sport school socialHandles' }
      });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    res.json({ campaign });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/campaigns — gated by the brand's plan campaign allowance (Free = 0).
router.post('/', requireAuth, requireRole('brand'), async (req, res) => {
  try {
    // Enforce the per-tier campaign cap (Free = 0 → must upgrade; Pro/Elite = ∞).
    const limit = planLimit(req.user, 'campaigns');
    if (limit <= 0) {
      const min = minPlanForLimit('brand', 'campaigns', 1);
      return upgradeRequired(res, `Campaigns are available on the ${min ? min.name : 'Starter'} plan and up. Upgrade to launch campaigns.`, min);
    }
    if (Number.isFinite(limit)) {
      const used = await Campaign.countDocuments({ brand: req.user._id });
      if (used >= limit) {
        const min = minPlanForLimit('brand', 'campaigns', limit + 1);
        return upgradeRequired(res, `Your plan allows ${limit} campaign${limit === 1 ? '' : 's'}. Upgrade${min ? ` to ${min.name}` : ''} for more.`, min);
      }
    }
    const {
      title, description, budget, startDate, endDate,
      targetSports, targetPlatforms, goals, coverImage
    } = req.body;

    const campaign = await Campaign.create({
      title, description, budget, startDate, endDate,
      targetSports, targetPlatforms, goals, coverImage,
      brand: req.user._id
    });

    await Activity.create({
      user: req.user._id,
      type: 'campaign_launched',
      title: 'Campaign created',
      message: `New campaign: ${title}`,
      relatedCampaign: campaign._id
    });

    res.status(201).json({ campaign });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/campaigns/:id
router.put('/:id', requireAuth, requireRole('brand'), async (req, res) => {
  try {
    const campaign = await Campaign.findOneAndUpdate(
      { _id: req.params.id, brand: req.user._id },
      req.body,
      { new: true }
    );
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    res.json({ campaign });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/campaigns/:id
router.delete('/:id', requireAuth, requireRole('brand'), async (req, res) => {
  try {
    const campaign = await Campaign.findOneAndDelete({ _id: req.params.id, brand: req.user._id, status: 'draft' });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found or cannot be deleted' });
    res.json({ message: 'Campaign deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
