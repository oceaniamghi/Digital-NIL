import express from 'express';
import { getLicenseState } from '../lib/license.js';

const router = express.Router();

// Public, unauthenticated, and never gated — the client polls this to decide
// whether to show the lock screen. Exposes only the lock flag + reason, no secrets.
router.get('/status', async (req, res) => {
  const s = await getLicenseState();
  res.json({ locked: s.locked, reason: s.reason });
});

export default router;
