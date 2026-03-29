import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import Content from '../models/Content.js';
import Activity from '../models/Activity.js';
import Deal from '../models/Deal.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = express.Router();

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = process.env.UPLOAD_DIR || './uploads';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `content_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE) || 52428800 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp|mp4|mov|avi|pdf/;
    const ext = allowed.test(path.extname(file.originalname).toLowerCase());
    const mime = allowed.test(file.mimetype);
    if (ext || mime) cb(null, true);
    else cb(new Error('Invalid file type'));
  }
});

// GET /api/content
router.get('/', requireAuth, async (req, res) => {
  try {
    const { status, dealId } = req.query;
    const query = req.user.role === 'brand'
      ? { brand: req.user._id }
      : { createdBy: req.user._id };
    if (status) query.status = status;
    if (dealId) query.deal = dealId;

    const content = await Content.find(query)
      .populate('deal', 'title compensation brand')
      .populate('brand', 'name company logo')
      .populate('createdBy', 'name avatar')
      .sort({ createdAt: -1 });

    res.json({ content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/content/:id
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const content = await Content.findById(req.params.id)
      .populate('deal', 'title compensation disclosureTag brand')
      .populate('brand', 'name company logo')
      .populate('createdBy', 'name avatar sport');
    if (!content) return res.status(404).json({ error: 'Content not found' });
    res.json({ content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/content/upload
router.post('/upload', requireAuth, upload.single('file'), async (req, res) => {
  try {
    const { title, caption, hashtags, disclosureTag, dealId, campaignId, platforms, type } = req.body;
    const baseUrl = process.env.BASE_URL || 'http://localhost:5000';
    const fileUrl = req.file ? `${baseUrl}/uploads/${req.file.filename}` : '';
    const mimeType = req.file?.mimetype || '';
    const fileSize = req.file?.size || 0;

    const deal = dealId ? await Deal.findById(dealId) : null;

    const content = await Content.create({
      title,
      caption: caption || '',
      hashtags: hashtags ? JSON.parse(hashtags) : [],
      disclosureTag: disclosureTag || '#ad',
      deal: dealId || undefined,
      campaign: campaignId || undefined,
      brand: deal?.brand || undefined,
      createdBy: req.user._id,
      type: type || (mimeType.startsWith('video') ? 'video' : 'image'),
      fileUrl,
      mimeType,
      fileSize,
      platforms: platforms ? JSON.parse(platforms) : [],
      status: dealId ? 'pending_review' : 'draft'
    });

    await Activity.create({
      user: req.user._id,
      type: 'content_submitted',
      title: 'Content submitted',
      message: `Submitted "${title}" for review`,
      relatedContent: content._id,
      relatedDeal: dealId || undefined
    });

    if (deal) {
      await Activity.create({
        user: deal.brand,
        type: 'content_submitted',
        title: 'New content to review',
        message: `${req.user.name} submitted content for: ${deal.title}`,
        relatedContent: content._id,
        relatedDeal: dealId
      });
    }

    res.status(201).json({ content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/content/:id/approve
router.put('/:id/approve', requireAuth, requireRole('brand'), async (req, res) => {
  try {
    const content = await Content.findOneAndUpdate(
      { _id: req.params.id, brand: req.user._id },
      { status: 'approved' },
      { new: true }
    );
    if (!content) return res.status(404).json({ error: 'Content not found' });

    await Activity.create({
      user: content.createdBy,
      type: 'content_approved',
      title: 'Content approved!',
      message: `Your content "${content.title}" has been approved. Ready to post!`,
      relatedContent: content._id
    });

    res.json({ content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/content/:id/reject
router.put('/:id/reject', requireAuth, requireRole('brand'), async (req, res) => {
  try {
    const { reason } = req.body;
    const content = await Content.findOneAndUpdate(
      { _id: req.params.id, brand: req.user._id },
      { status: 'rejected', rejectionReason: reason || '' },
      { new: true }
    );
    if (!content) return res.status(404).json({ error: 'Content not found' });

    await Activity.create({
      user: content.createdBy,
      type: 'content_rejected',
      title: 'Content needs revision',
      message: `"${content.title}" was rejected: ${reason || 'No reason provided'}`,
      relatedContent: content._id
    });

    res.json({ content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/content/:id/post — athlete marks content as posted
router.put('/:id/post', requireAuth, async (req, res) => {
  try {
    const content = await Content.findOneAndUpdate(
      { _id: req.params.id, createdBy: req.user._id, status: 'approved' },
      { status: 'posted', postedAt: new Date() },
      { new: true }
    );
    if (!content) return res.status(404).json({ error: 'Content not found or not approved' });

    await Activity.create({
      user: req.user._id,
      type: 'content_posted',
      title: 'Content posted!',
      message: `"${content.title}" has been published`,
      relatedContent: content._id
    });

    res.json({ content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/content/:id/metrics
router.put('/:id/metrics', requireAuth, async (req, res) => {
  try {
    const content = await Content.findById(req.params.id);
    if (!content) return res.status(404).json({ error: 'Content not found' });
    const { platform, impressions, clicks, likes, shares, comments, reach } = req.body;
    const existing = content.metrics.find(m => m.platform === platform);
    if (existing) {
      Object.assign(existing, { impressions, clicks, likes, shares, comments, reach });
    } else {
      content.metrics.push({ platform, impressions, clicks, likes, shares, comments, reach });
    }
    await content.save();
    res.json({ content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/content/:id
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const content = await Content.findOneAndDelete({
      _id: req.params.id,
      createdBy: req.user._id,
      status: { $in: ['draft', 'rejected'] }
    });
    if (!content) return res.status(404).json({ error: 'Content not found or cannot be deleted' });
    res.json({ message: 'Content deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
