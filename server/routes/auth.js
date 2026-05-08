import express from 'express';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import Activity from '../models/Activity.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

const signToken = (userId) =>
  jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '30d' });

// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { email, password, name, role, sport, school, company, industry, agency } = req.body;
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, password, and name are required' });
    }
    const existing = await User.findOne({ email });
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const user = await User.create({
      email, password, name, role: role || 'athlete',
      sport, school, company, industry, agency
    });

    const token = signToken(user._id);
    const { password: _, ...userObj } = user.toObject();
    res.status(201).json({ token, user: userObj });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const user = await User.findOne({ email });
    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = signToken(user._id);
    const { password: _, ...userObj } = user.toObject();
    res.json({ token, user: userObj });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// PUT /api/auth/profile
router.put('/profile', requireAuth, async (req, res) => {
  try {
    const allowed = ['name', 'bio', 'avatar', 'sport', 'school', 'position', 'graduationYear',
      'proStatus', 'nflTeam', 'statsUrl',
      'socialHandles', 'company', 'industry', 'website', 'logo', 'agency'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    const user = await User.findByIdAndUpdate(req.user._id, updates, { new: true }).select('-password');
    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/auth/social
router.put('/social', requireAuth, async (req, res) => {
  try {
    const { platform, handle, followers } = req.body;
    const user = await User.findById(req.user._id);
    const idx = user.socialHandles.findIndex(s => s.platform === platform);
    if (idx >= 0) {
      user.socialHandles[idx] = { platform, handle, followers: followers || 0, connected: true };
    } else {
      user.socialHandles.push({ platform, handle, followers: followers || 0, connected: true });
    }
    await user.save();

    await Activity.create({
      user: user._id,
      type: 'social_connected',
      title: 'Social account connected',
      message: `Connected ${platform} account @${handle}`
    });

    const { password: _, ...userObj } = user.toObject();
    res.json({ user: userObj });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/athletes/:id — public athlete profile (for media kit sharing)
router.get('/athletes/:id', async (req, res) => {
  try {
    const athlete = await User.findById(req.params.id)
      .select('-password -email')
      .where('role').equals('athlete');
    if (!athlete) return res.status(404).json({ error: 'Athlete not found' });
    res.json({ athlete });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/athletes — public athlete directory
router.get('/athletes', requireAuth, async (req, res) => {
  try {
    const { sport, minFollowers, search } = req.query;
    const query = { role: 'athlete' };
    if (sport) query.sport = { $regex: sport, $options: 'i' };
    if (search) query.name = { $regex: search, $options: 'i' };

    let athletes = await User.find(query).select('-password').limit(50);

    if (minFollowers) {
      const min = parseInt(minFollowers);
      athletes = athletes.filter(a =>
        a.socialHandles.some(s => s.followers >= min)
      );
    }

    res.json({ athletes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
