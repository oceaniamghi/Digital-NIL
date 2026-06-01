import express from 'express';
import crypto from 'crypto';
import SystemSetting from '../models/SystemSetting.js';
import User from '../models/User.js';
import { getLicenseState, invalidateLicenseCache, envDisabled } from '../lib/license.js';

const router = express.Router();

// Constant-time secret comparison so the owner key can't be brute-forced by timing.
const secretMatch = (a, b) => {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
};

// Every owner route requires the vendor's OWNER_KEY (header or bearer). This is the
// remote control surface — it sits ABOVE the customer's in-app admin roles, so the
// customer can never re-enable a locked deployment.
router.use((req, res, next) => {
  const key = process.env.OWNER_KEY;
  if (!key) return res.status(503).json({ error: 'Owner controls are not configured. Set OWNER_KEY.' });
  const provided = req.headers['x-owner-key'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!provided || !secretMatch(provided, key)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// Billable seats = real, login-capable accounts. Agent-managed roster athletes
// (managed:true) and external brand/sponsor accounts are not counted.
const seatUsage = () => User.countDocuments({ managed: { $ne: true }, role: { $ne: 'brand' } });

router.get('/status', async (req, res) => {
  try {
    const state = await getLicenseState({ fresh: true });
    const doc = await SystemSetting.getSingleton();
    const seatsUsed = await seatUsage().catch(() => null);
    res.json({
      ...state,
      envDisabled: envDisabled(),
      seatsUsed,
      disabledReason: doc.disabledReason,
      customerName: doc.customerName,
      updatedAt: doc.updatedAt
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/lock', async (req, res) => {
  try {
    const doc = await SystemSetting.getSingleton();
    doc.disabled = true;
    doc.disabledReason = (req.body && req.body.reason) || 'Service suspended for non-payment.';
    doc.updatedAt = new Date();
    await doc.save();
    invalidateLicenseCache();
    res.json({ ok: true, locked: true, reason: doc.disabledReason });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/unlock', async (req, res) => {
  try {
    const doc = await SystemSetting.getSingleton();
    doc.disabled = false;
    doc.disabledReason = '';
    doc.updatedAt = new Date();
    await doc.save();
    invalidateLicenseCache();
    const state = await getLicenseState({ fresh: true });
    res.json({
      ok: true,
      locked: state.locked,
      note: envDisabled()
        ? 'DB unlocked, but APP_DISABLED is still set in the environment — the app stays locked until you clear it and redeploy.'
        : undefined
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/paid-through', async (req, res) => {
  try {
    const { date } = req.body || {};
    let d = null;
    if (date) {
      d = new Date(date);
      if (isNaN(d.getTime())) return res.status(400).json({ error: 'Invalid date' });
    }
    const doc = await SystemSetting.getSingleton();
    doc.paidThrough = d;
    doc.updatedAt = new Date();
    await doc.save();
    invalidateLicenseCache();
    res.json({ ok: true, paidThrough: doc.paidThrough });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/seat-limit', async (req, res) => {
  try {
    const n = Number(req.body?.limit);
    if (!Number.isFinite(n) || n < 1) return res.status(400).json({ error: 'Invalid limit' });
    const doc = await SystemSetting.getSingleton();
    doc.seatLimit = Math.floor(n);
    doc.updatedAt = new Date();
    await doc.save();
    invalidateLicenseCache();
    res.json({ ok: true, seatLimit: doc.seatLimit });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Grant (or revoke) an athlete's media-kit export entitlement after a manual
// Stripe payment. Bridge until a Stripe webhook flips this automatically.
//   curl -X POST $URL/api/owner/export-tier -H "x-owner-key: $OWNER_KEY" \
//        -H "Content-Type: application/json" -d '{"email":"athlete@x.com","tier":"kit"}'
router.post('/export-tier', async (req, res) => {
  try {
    const { email, tier } = req.body || {};
    if (!email) return res.status(400).json({ error: 'email is required' });
    if (!['free', 'kit', 'pack'].includes(tier)) {
      return res.status(400).json({ error: "tier must be 'free', 'kit', or 'pack'" });
    }
    const user = await User.findOneAndUpdate(
      { email: String(email).toLowerCase().trim(), role: 'athlete' },
      { exportTier: tier },
      { new: true }
    ).select('name email exportTier');
    if (!user) return res.status(404).json({ error: 'Athlete not found' });
    res.json({ ok: true, name: user.name, email: user.email, exportTier: user.exportTier });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
