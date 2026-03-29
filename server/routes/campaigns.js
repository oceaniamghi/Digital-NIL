import express from 'express';
import Campaign from '../models/Campaign.js';
import Deal from '../models/Deal.js';
import Activity from '../models/Activity.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

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

// POST /api/campaigns
router.post('/', requireAuth, requireRole('brand'), async (req, res) => {
  try {
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
