import express from 'express';
import User from '../models/User.js';
import { requireAuth } from '../middleware/auth.js';
import { renderAthletePdf, renderAthleteCard } from '../lib/render.js';

const router = express.Router();

// Render the same server's public /athlete/:id page (no auth needed by Chromium).
const publicUrl = (req, id) => `${req.protocol}://${req.get('host')}/athlete/${id}`;
const slug = (s) => (s || 'athlete').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Auth-gated because headless Chromium is heavy — don't expose it to anonymous load.
// PAID: the high-end PDF media kit requires a 'kit' or 'pack' entitlement on the
// athlete. Free accounts get the share-card PNG below; this is the upgrade.
router.get('/athlete/:id/pdf', requireAuth, async (req, res) => {
  try {
    const a = await User.findById(req.params.id).where('role').equals('athlete').select('name exportTier');
    if (!a) return res.status(404).json({ error: 'Athlete not found' });
    if (!['kit', 'pack'].includes(a.exportTier)) {
      return res.status(402).json({
        error: 'Upgrade required',
        message: 'The high-end media-kit PDF is a paid export. The free share card is available now; unlock the full kit to export this PDF.',
        upgrade: { kit: 'from $99', pack: 'from $299 (includes program outreach)' }
      });
    }
    const pdf = await renderAthletePdf(publicUrl(req, req.params.id));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${slug(a.name)}-media-kit.pdf"`);
    res.send(pdf);
  } catch (err) {
    res.status(503).json({ error: 'Media-kit export unavailable: ' + err.message });
  }
});

router.get('/athlete/:id/card', requireAuth, async (req, res) => {
  try {
    const a = await User.findById(req.params.id).where('role').equals('athlete').select('name');
    if (!a) return res.status(404).json({ error: 'Athlete not found' });
    const png = await renderAthleteCard(publicUrl(req, req.params.id));
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', `attachment; filename="${slug(a.name)}-card.png"`);
    res.send(png);
  } catch (err) {
    res.status(503).json({ error: 'Share-card export unavailable: ' + err.message });
  }
});

export default router;
