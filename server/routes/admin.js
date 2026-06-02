import express from 'express';
import User from '../models/User.js';
import Activity from '../models/Activity.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = express.Router();

// In-app admin console. This is the CUSTOMER's super-user (role:'admin') — it can
// master-edit every login, curate the featured "top 20" showcase, and moderate the
// in-app message/notification feed. It sits BELOW the vendor's OWNER_KEY controls
// (server/routes/owner.js), which remain the only surface that can lock the deploy.
router.use(requireAuth, requireRole('admin'));

const SAFE = '-password -verifyToken';
const MAX_FEATURED = 20;

// GET /api/admin/stats — headline counts for the console.
router.get('/stats', async (req, res) => {
  try {
    const [athletes, agents, brands, admins, featured, unverified] = await Promise.all([
      User.countDocuments({ role: 'athlete' }),
      User.countDocuments({ role: 'agent' }),
      User.countDocuments({ role: 'brand' }),
      User.countDocuments({ role: 'admin' }),
      User.countDocuments({ role: 'athlete', featured: true }),
      User.countDocuments({ verified: false })
    ]);
    res.json({ athletes, agents, brands, admins, featured, maxFeatured: MAX_FEATURED, unverified });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/users?role=&search= — full directory across every role.
router.get('/users', async (req, res) => {
  try {
    const { role, search } = req.query;
    const query = {};
    if (role && role !== 'all') query.role = role;
    if (search) {
      const rx = { $regex: String(search).trim(), $options: 'i' };
      query.$or = [{ name: rx }, { email: rx }, { company: rx }, { agency: rx }];
    }
    const users = await User.find(query).select(SAFE).sort({ createdAt: -1 }).limit(500);
    res.json({ users });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/users/:id — master-edit a user record (the app + login fields).
const EDITABLE = ['name', 'email', 'role', 'verified', 'onboarded', 'featured',
  'phone', 'signupFeePaid', 'cardOnFile', 'sport', 'school', 'position', 'company',
  'industry', 'agency', 'bio', 'nilValue', 'exportTier', 'managed'];
router.put('/users/:id', async (req, res) => {
  try {
    const updates = {};
    for (const k of EDITABLE) if (req.body[k] !== undefined) updates[k] = req.body[k];
    if (updates.email) updates.email = String(updates.email).toLowerCase().trim();
    if (updates.role && !['athlete', 'brand', 'agent', 'admin'].includes(updates.role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    // Enforce the featured cap when turning one on.
    if (updates.featured === true) {
      const count = await User.countDocuments({ role: 'athlete', featured: true, _id: { $ne: req.params.id } });
      if (count >= MAX_FEATURED) {
        return res.status(400).json({ error: `The featured list is full (${MAX_FEATURED} max). Remove one first.` });
      }
    }
    const user = await User.findByIdAndUpdate(req.params.id, updates, { new: true, runValidators: true }).select(SAFE);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user });
  } catch (err) {
    // Surface duplicate-email cleanly.
    if (err.code === 11000) return res.status(409).json({ error: 'That email is already in use.' });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/users/:id/password — master-reset a login password.
router.post('/users/:id/password', async (req, res) => {
  try {
    const { password } = req.body || {};
    if (!password || String(password).length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    user.password = password;          // hashed by the model pre-save hook
    await user.save();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/users/:id/featured — toggle an athlete on/off the top-20 showcase.
router.post('/users/:id/featured', async (req, res) => {
  try {
    const on = req.body.featured !== false;
    const target = await User.findById(req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.role !== 'athlete') return res.status(400).json({ error: 'Only athletes can be featured.' });
    if (on && !target.featured) {
      const count = await User.countDocuments({ role: 'athlete', featured: true });
      if (count >= MAX_FEATURED) {
        return res.status(400).json({ error: `The featured list is full (${MAX_FEATURED} max). Remove one first.` });
      }
    }
    target.featured = on;
    await target.save();
    res.json({ ok: true, featured: target.featured });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/users/:id — remove a user (can't delete yourself).
router.delete('/users/:id', async (req, res) => {
  try {
    if (String(req.params.id) === String(req.user._id)) {
      return res.status(400).json({ error: 'You cannot delete your own admin account.' });
    }
    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/messages — global in-app message / notification feed.
router.get('/messages', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const messages = await Activity.find()
      .populate('user', 'name email role')
      .sort({ createdAt: -1 })
      .limit(limit);
    res.json({ messages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/messages/:id — master-edit a message's title/body.
router.put('/messages/:id', async (req, res) => {
  try {
    const updates = {};
    if (req.body.title !== undefined) updates.title = req.body.title;
    if (req.body.message !== undefined) updates.message = req.body.message;
    if (req.body.read !== undefined) updates.read = req.body.read;
    const msg = await Activity.findByIdAndUpdate(req.params.id, updates, { new: true })
      .populate('user', 'name email role');
    if (!msg) return res.status(404).json({ error: 'Message not found' });
    res.json({ message: msg });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/messages/:id — remove a message from the feed.
router.delete('/messages/:id', async (req, res) => {
  try {
    const msg = await Activity.findByIdAndDelete(req.params.id);
    if (!msg) return res.status(404).json({ error: 'Message not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
