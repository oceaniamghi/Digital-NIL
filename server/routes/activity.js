import express from 'express';
import Activity from '../models/Activity.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

// GET /api/activity
router.get('/', requireAuth, async (req, res) => {
  try {
    const { limit = 20, offset = 0 } = req.query;
    const activities = await Activity.find({ user: req.user._id })
      .sort({ createdAt: -1 })
      .skip(parseInt(offset))
      .limit(parseInt(limit))
      .populate('relatedDeal', 'title')
      .populate('relatedCampaign', 'title')
      .populate('relatedContent', 'title');
    res.json({ activities });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/activity/unread-count
router.get('/unread-count', requireAuth, async (req, res) => {
  try {
    const count = await Activity.countDocuments({ user: req.user._id, read: false });
    res.json({ count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/activity/read-all
router.put('/read-all', requireAuth, async (req, res) => {
  try {
    await Activity.updateMany({ user: req.user._id, read: false }, { read: true });
    res.json({ message: 'All marked as read' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/activity/:id/read
router.put('/:id/read', requireAuth, async (req, res) => {
  try {
    const activity = await Activity.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      { read: true },
      { new: true }
    );
    if (!activity) return res.status(404).json({ error: 'Activity not found' });
    res.json({ activity });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
