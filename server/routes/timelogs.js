import express from 'express';
import TimeLog from '../models/TimeLog.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

// All timelog routes require authentication
router.use(requireAuth);

// POST /api/timelogs — create a new time entry
router.post('/', async (req, res) => {
  try {
    const { date, hours, feature, activityType, isQRA, uncertainty, description, outcome, workerType, workerEntity } = req.body;
    const log = await TimeLog.create({
      user: req.user._id,
      date, hours, feature, activityType,
      isQRA: isQRA !== undefined ? isQRA : !['documentation', 'meetings-planning'].includes(activityType),
      uncertainty, description, outcome,
      workerType: workerType || 'contractor',
      workerEntity: workerEntity || 'United Gates LLC'
    });
    res.status(201).json({ log });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/timelogs — list entries (filterable by quarter, feature, isQRA)
router.get('/', async (req, res) => {
  try {
    const { quarter, feature, isQRA, limit = 100, offset = 0 } = req.query;
    const query = { user: req.user._id };
    if (quarter) query.quarter = quarter;
    if (feature) query.feature = feature;
    if (isQRA !== undefined) query.isQRA = isQRA === 'true';

    const [logs, total] = await Promise.all([
      TimeLog.find(query).sort({ date: -1 }).skip(Number(offset)).limit(Number(limit)),
      TimeLog.countDocuments(query)
    ]);
    res.json({ logs, total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/timelogs/summary — aggregate QRE hours/$ for R&D credit report
router.get('/summary', async (req, res) => {
  try {
    const { quarter, year } = req.query;
    const match = { user: req.user._id };
    if (quarter) match.quarter = quarter;
    if (year) {
      match.date = {
        $gte: new Date(`${year}-01-01`),
        $lte: new Date(`${year}-12-31`)
      };
    }

    const [byFeature, byActivityType, byQuarter, totals] = await Promise.all([
      // Hours broken down by feature
      TimeLog.aggregate([
        { $match: match },
        { $group: { _id: { feature: '$feature', isQRA: '$isQRA' }, hours: { $sum: '$hours' }, entries: { $sum: 1 } } },
        { $sort: { '_id.feature': 1 } }
      ]),
      // Hours broken down by activity type
      TimeLog.aggregate([
        { $match: match },
        { $group: { _id: { activityType: '$activityType', isQRA: '$isQRA' }, hours: { $sum: '$hours' } } },
        { $sort: { '_id.activityType': 1 } }
      ]),
      // Hours by quarter
      TimeLog.aggregate([
        { $match: { user: req.user._id } },
        { $group: { _id: { quarter: '$quarter', isQRA: '$isQRA' }, hours: { $sum: '$hours' } } },
        { $sort: { '_id.quarter': 1 } }
      ]),
      // Grand totals
      TimeLog.aggregate([
        { $match: match },
        { $group: { _id: '$isQRA', totalHours: { $sum: '$hours' }, entries: { $sum: 1 } } }
      ])
    ]);

    const qraHours = totals.find(t => t._id === true)?.totalHours || 0;
    const nonQraHours = totals.find(t => t._id === false)?.totalHours || 0;

    res.json({ byFeature, byActivityType, byQuarter, qraHours, nonQraHours, totalHours: qraHours + nonQraHours });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/timelogs/report — CSV-ready flat export for tax preparer
router.get('/report', async (req, res) => {
  try {
    const { quarter, year } = req.query;
    const match = { user: req.user._id };
    if (quarter) match.quarter = quarter;
    if (year) {
      match.date = {
        $gte: new Date(`${year}-01-01`),
        $lte: new Date(`${year}-12-31`)
      };
    }
    const logs = await TimeLog.find(match).sort({ date: 1 }).populate('user', 'name email role');

    // Return as JSON (client renders as CSV)
    const rows = logs.map(l => ({
      date: new Date(l.date).toISOString().split('T')[0],
      quarter: l.quarter,
      worker: l.user?.name || '',
      workerEntity: l.workerEntity,
      workerType: l.workerType,
      feature: l.feature,
      activityType: l.activityType,
      isQRA: l.isQRA ? 'YES' : 'NO',
      hours: l.hours,
      uncertainty: l.uncertainty,
      description: l.description,
      outcome: l.outcome
    }));

    res.json({ rows, count: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/timelogs/:id — edit an entry (same day only, or admin)
router.put('/:id', async (req, res) => {
  try {
    const log = await TimeLog.findOne({ _id: req.params.id, user: req.user._id });
    if (!log) return res.status(404).json({ error: 'Entry not found' });
    const allowed = ['hours', 'feature', 'activityType', 'isQRA', 'uncertainty', 'description', 'outcome'];
    allowed.forEach(k => { if (req.body[k] !== undefined) log[k] = req.body[k]; });
    await log.save();
    res.json({ log });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/timelogs/:id
router.delete('/:id', async (req, res) => {
  try {
    await TimeLog.findOneAndDelete({ _id: req.params.id, user: req.user._id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
