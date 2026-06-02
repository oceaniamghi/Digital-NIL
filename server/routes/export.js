import express from 'express';
import User from '../models/User.js';
import { requireAuth } from '../middleware/auth.js';
import { planCan, minPlanForCap } from '../lib/plans.js';
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
    const a = await User.findById(req.params.id).where('role').equals('athlete').select('name exportTier plan role');
    if (!a) return res.status(404).json({ error: 'Athlete not found' });
    // PAID: the high-end PDF requires an athlete plan with the `mediaKitPdf`
    // capability (Plus+). Legacy one-time export purchases (exportTier kit/pack)
    // still count. The free share card below remains available to everyone.
    const entitled = planCan(a, 'mediaKitPdf') || ['kit', 'pack'].includes(a.exportTier);
    if (!entitled) {
      const min = minPlanForCap('athlete', 'mediaKitPdf');
      return res.status(402).json({
        error: 'Upgrade required',
        message: `The high-end media-kit PDF is part of the athlete ${min ? min.name : 'Plus'} plan. The free share card is available now; upgrade to export the full kit.`,
        upgrade: { plan: min ? min.key : 'plus', planName: min ? min.name : 'Plus' }
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
