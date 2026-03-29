import express from 'express';
import Deal from '../models/Deal.js';
import Content from '../models/Content.js';
import Campaign from '../models/Campaign.js';
import User from '../models/User.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

// GET /api/analytics/overview
router.get('/overview', requireAuth, async (req, res) => {
  try {
    const userId = req.user._id;
    const role = req.user.role;

    if (role === 'athlete') {
      const [activeDeals, completedDeals, pendingContent, postedContent] = await Promise.all([
        Deal.countDocuments({ athlete: userId, status: 'active' }),
        Deal.countDocuments({ athlete: userId, status: 'completed' }),
        Content.countDocuments({ createdBy: userId, status: { $in: ['pending_review', 'approved'] } }),
        Content.countDocuments({ createdBy: userId, status: 'posted' })
      ]);

      const earnings = await Deal.aggregate([
        { $match: { athlete: userId, status: 'completed' } },
        { $group: { _id: null, total: { $sum: '$compensation.amount' } } }
      ]);

      const totalFollowers = req.user.socialHandles?.reduce((sum, s) => sum + (s.followers || 0), 0) || 0;

      const contentMetrics = await Content.aggregate([
        { $match: { createdBy: userId, status: 'posted' } },
        { $unwind: '$metrics' },
        {
          $group: {
            _id: null,
            totalImpressions: { $sum: '$metrics.impressions' },
            totalClicks: { $sum: '$metrics.clicks' },
            totalLikes: { $sum: '$metrics.likes' },
            totalShares: { $sum: '$metrics.shares' }
          }
        }
      ]);

      const recentDeals = await Deal.find({ athlete: userId })
        .populate('brand', 'name company logo')
        .sort({ updatedAt: -1 })
        .limit(5);

      res.json({
        stats: {
          activeDeals,
          completedDeals,
          pendingContent,
          postedContent,
          totalEarnings: earnings[0]?.total || req.user.totalEarnings || 0,
          totalFollowers,
          ...(contentMetrics[0] || {
            totalImpressions: 0, totalClicks: 0, totalLikes: 0, totalShares: 0
          })
        },
        recentDeals
      });
    } else if (role === 'brand') {
      const [activeCampaigns, activeDeals, completedDeals, pendingReviews] = await Promise.all([
        Campaign.countDocuments({ brand: userId, status: 'active' }),
        Deal.countDocuments({ brand: userId, status: 'active' }),
        Deal.countDocuments({ brand: userId, status: 'completed' }),
        Content.countDocuments({ brand: userId, status: 'pending_review' })
      ]);

      const spend = await Deal.aggregate([
        { $match: { brand: userId, status: 'completed' } },
        { $group: { _id: null, total: { $sum: '$compensation.amount' } } }
      ]);

      const campaignMetrics = await Campaign.aggregate([
        { $match: { brand: userId } },
        {
          $group: {
            _id: null,
            totalImpressions: { $sum: '$metrics.impressions' },
            totalReach: { $sum: '$metrics.reach' },
            totalEngagements: { $sum: '$metrics.engagements' }
          }
        }
      ]);

      const recentDeals = await Deal.find({ brand: userId })
        .populate('athlete', 'name avatar sport school socialHandles')
        .sort({ updatedAt: -1 })
        .limit(5);

      res.json({
        stats: {
          activeCampaigns,
          activeDeals,
          completedDeals,
          pendingReviews,
          totalSpend: spend[0]?.total || 0,
          ...(campaignMetrics[0] || {
            totalImpressions: 0, totalReach: 0, totalEngagements: 0
          })
        },
        recentDeals
      });
    } else {
      res.json({ stats: {}, recentDeals: [] });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/analytics/earnings — monthly earnings chart data (athlete)
router.get('/earnings', requireAuth, async (req, res) => {
  try {
    const months = 6;
    const start = new Date();
    start.setMonth(start.getMonth() - months + 1);
    start.setDate(1);
    start.setHours(0, 0, 0, 0);

    const query = req.user.role === 'athlete'
      ? { athlete: req.user._id, status: 'completed' }
      : { brand: req.user._id, status: 'completed' };

    const data = await Deal.aggregate([
      { $match: { ...query, updatedAt: { $gte: start } } },
      {
        $group: {
          _id: {
            year: { $year: '$updatedAt' },
            month: { $month: '$updatedAt' }
          },
          total: { $sum: '$compensation.amount' },
          count: { $sum: 1 }
        }
      },
      { $sort: { '_id.year': 1, '_id.month': 1 } }
    ]);

    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const result = [];
    for (let i = 0; i < months; i++) {
      const d = new Date(start);
      d.setMonth(d.getMonth() + i);
      const year = d.getFullYear();
      const month = d.getMonth() + 1;
      const found = data.find(x => x._id.year === year && x._id.month === month);
      result.push({
        label: monthNames[month - 1],
        total: found?.total || 0,
        count: found?.count || 0
      });
    }

    res.json({ earnings: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/analytics/deals — deal performance breakdown
router.get('/deals', requireAuth, async (req, res) => {
  try {
    const query = req.user.role === 'brand'
      ? { brand: req.user._id }
      : { athlete: req.user._id };

    const breakdown = await Deal.aggregate([
      { $match: query },
      { $group: { _id: '$status', count: { $sum: 1 }, total: { $sum: '$compensation.amount' } } }
    ]);

    const byType = await Deal.aggregate([
      { $match: query },
      { $group: { _id: '$type', count: { $sum: 1 } } }
    ]);

    res.json({ breakdown, byType });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
