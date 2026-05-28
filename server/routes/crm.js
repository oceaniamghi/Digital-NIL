import express from 'express';
import mongoose from 'mongoose';
import Company from '../models/Company.js';
import Contact from '../models/Contact.js';
import Opportunity, { STAGES, STAGE_PROBABILITY } from '../models/Opportunity.js';
import Lead, { LEAD_STATUSES } from '../models/Lead.js';
import CrmEvent from '../models/CrmEvent.js';
import Deal from '../models/Deal.js';
import Activity from '../models/Activity.js';
import User from '../models/User.js';
import { sendEmail } from '../lib/resend.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = express.Router();

// Agent-only CRM (sponsor acquisition). Every record is scoped to its owner.
router.use(requireAuth, requireRole('agent'));

const oid = (id) => mongoose.Types.ObjectId.isValid(id);

// ── Companies ────────────────────────────────────────────────────────────────
router.get('/companies', async (req, res) => {
  try {
    const companies = await Company.find({ owner: req.user._id })
      .populate('linkedUser', 'name company logo')
      .sort({ updatedAt: -1 })
      .lean();

    // Attach open-opportunity count + pipeline value per company.
    const agg = await Opportunity.aggregate([
      { $match: { owner: req.user._id, stage: { $nin: ['lost'] } } },
      { $group: { _id: '$company', openOpps: { $sum: 1 }, pipelineValue: { $sum: '$value' } } }
    ]);
    const byCompany = Object.fromEntries(agg.map(a => [String(a._id), a]));
    for (const c of companies) {
      const m = byCompany[String(c._id)];
      c.openOpps = m?.openOpps || 0;
      c.pipelineValue = m?.pipelineValue || 0;
    }
    res.json({ companies });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/companies', async (req, res) => {
  try {
    const { name, type, logo, domain, website, industry, location, notes, tags, linkedUser } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const company = await Company.create({
      name, type, logo, domain, website, industry, location, notes, tags,
      linkedUser: linkedUser || null, owner: req.user._id
    });
    res.status(201).json({ company });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/companies/:id', async (req, res) => {
  try {
    const allowed = ['name', 'type', 'logo', 'domain', 'website', 'industry', 'location', 'notes', 'tags', 'linkedUser'];
    const updates = {};
    for (const k of allowed) if (req.body[k] !== undefined) updates[k] = req.body[k];
    if (updates.linkedUser === '') updates.linkedUser = null;
    const company = await Company.findOneAndUpdate(
      { _id: req.params.id, owner: req.user._id }, updates, { new: true }
    ).populate('linkedUser', 'name company logo');
    if (!company) return res.status(404).json({ error: 'Company not found' });
    res.json({ company });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/companies/:id', async (req, res) => {
  try {
    const company = await Company.findOneAndDelete({ _id: req.params.id, owner: req.user._id });
    if (!company) return res.status(404).json({ error: 'Company not found' });
    await Contact.deleteMany({ company: company._id, owner: req.user._id });
    res.json({ message: 'Company deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Onboarded brand accounts available to link a company to (for deal conversion).
router.get('/brand-accounts', async (req, res) => {
  try {
    const brands = await User.find({ role: 'brand' })
      .select('name company logo industry')
      .sort({ company: 1 })
      .lean();
    res.json({ brands });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Contacts ─────────────────────────────────────────────────────────────────
router.get('/contacts', async (req, res) => {
  try {
    const query = { owner: req.user._id };
    if (req.query.company && oid(req.query.company)) query.company = req.query.company;
    const contacts = await Contact.find(query)
      .populate('company', 'name logo type')
      .sort({ updatedAt: -1 });
    res.json({ contacts });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/contacts', async (req, res) => {
  try {
    const { name, email, phone, title, tags, notes, company } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const contact = await Contact.create({
      name, email, phone, title, tags, notes,
      company: company || undefined, owner: req.user._id
    });
    const populated = await contact.populate('company', 'name logo type');
    res.status(201).json({ contact: populated });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/contacts/:id', async (req, res) => {
  try {
    const allowed = ['name', 'email', 'phone', 'title', 'tags', 'notes', 'company'];
    const updates = {};
    for (const k of allowed) if (req.body[k] !== undefined) updates[k] = req.body[k];
    if (updates.company === '') updates.company = null;
    const contact = await Contact.findOneAndUpdate(
      { _id: req.params.id, owner: req.user._id }, updates, { new: true }
    ).populate('company', 'name logo type');
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    res.json({ contact });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/contacts/:id', async (req, res) => {
  try {
    const contact = await Contact.findOneAndDelete({ _id: req.params.id, owner: req.user._id });
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    res.json({ message: 'Contact deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Opportunities ────────────────────────────────────────────────────────────
const OPP_POPULATE = [
  { path: 'company', select: 'name logo type linkedUser' },
  { path: 'primaryContact', select: 'name email title' },
  { path: 'targetAthletes', select: 'name avatar sport school position' }
];

router.get('/opportunities', async (req, res) => {
  try {
    const opportunities = await Opportunity.find({ owner: req.user._id })
      .populate(OPP_POPULATE)
      .sort({ updatedAt: -1 });
    res.json({ opportunities });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/opportunities', async (req, res) => {
  try {
    const {
      title, company, primaryContact, value, commissionPct, sports,
      platforms, targetAthletes, deliverables, expectedCloseDate, source
    } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });
    if (!company || !oid(company)) return res.status(400).json({ error: 'company required' });

    // Guard: company must belong to this agent.
    const owns = await Company.exists({ _id: company, owner: req.user._id });
    if (!owns) return res.status(403).json({ error: 'Company not in your CRM' });

    const opp = await Opportunity.create({
      title, company,
      primaryContact: primaryContact || undefined,
      value: value || 0, commissionPct: commissionPct || 0,
      sports, platforms, targetAthletes, deliverables,
      expectedCloseDate: expectedCloseDate || undefined,
      source: source || 'outbound',
      owner: req.user._id,
      stage: 'prospect', probability: STAGE_PROBABILITY.prospect,
      stageEnteredAt: new Date()
    });
    const populated = await opp.populate(OPP_POPULATE);
    res.status(201).json({ opportunity: populated });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/opportunities/:id', async (req, res) => {
  try {
    const opportunity = await Opportunity.findOne({ _id: req.params.id, owner: req.user._id })
      .populate(OPP_POPULATE)
      .populate('linkedDeal', 'title status');
    if (!opportunity) return res.status(404).json({ error: 'Opportunity not found' });
    const events = await CrmEvent.find({ opportunity: opportunity._id }).sort({ createdAt: -1 });
    res.json({ opportunity, events });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/opportunities/:id', async (req, res) => {
  try {
    const allowed = ['title', 'primaryContact', 'value', 'commissionPct', 'sports',
      'platforms', 'targetAthletes', 'deliverables', 'expectedCloseDate', 'source'];
    const updates = {};
    for (const k of allowed) if (req.body[k] !== undefined) updates[k] = req.body[k];
    if (updates.primaryContact === '') updates.primaryContact = null;
    const opportunity = await Opportunity.findOneAndUpdate(
      { _id: req.params.id, owner: req.user._id }, updates, { new: true }
    ).populate(OPP_POPULATE);
    if (!opportunity) return res.status(404).json({ error: 'Opportunity not found' });
    res.json({ opportunity });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Move a card to a new stage (drag-drop or stepper button).
router.put('/opportunities/:id/stage', async (req, res) => {
  try {
    const { stage, lostReason } = req.body;
    if (!STAGES.includes(stage)) return res.status(400).json({ error: 'Invalid stage' });
    const opp = await Opportunity.findOne({ _id: req.params.id, owner: req.user._id });
    if (!opp) return res.status(404).json({ error: 'Opportunity not found' });

    const from = opp.stage;
    if (from === stage) {
      const populated = await opp.populate(OPP_POPULATE);
      return res.json({ opportunity: populated });
    }
    opp.stage = stage;
    opp.probability = STAGE_PROBABILITY[stage] ?? opp.probability;
    opp.stageEnteredAt = new Date();
    if (stage === 'lost') opp.lostReason = lostReason || opp.lostReason;
    await opp.save();

    await CrmEvent.create({
      opportunity: opp._id, company: opp.company, contact: opp.primaryContact,
      owner: req.user._id, kind: 'stage_change', fromStage: from, toStage: stage,
      body: stage === 'lost' && lostReason ? `Lost: ${lostReason}` : ''
    });

    const populated = await opp.populate(OPP_POPULATE);
    res.json({ opportunity: populated });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Convert a signed/active opportunity into a real platform Deal.
router.post('/opportunities/:id/convert', async (req, res) => {
  try {
    const opp = await Opportunity.findOne({ _id: req.params.id, owner: req.user._id }).populate('company', 'linkedUser name');
    if (!opp) return res.status(404).json({ error: 'Opportunity not found' });
    if (!['signed', 'active'].includes(opp.stage)) {
      return res.status(400).json({ error: 'Only signed or active opportunities can be converted' });
    }
    if (opp.linkedDeal) return res.status(400).json({ error: 'Already converted to a deal' });
    if (!opp.company?.linkedUser) {
      return res.status(400).json({ error: 'Link this company to a brand account before converting' });
    }

    const singleAthlete = opp.targetAthletes?.length === 1 ? opp.targetAthletes[0] : undefined;
    const deal = await Deal.create({
      title: opp.title,
      description: `Converted from CRM opportunity with ${opp.company.name}.`,
      brand: opp.company.linkedUser,
      athlete: singleAthlete,
      type: 'social_post',
      platforms: opp.platforms || [],
      sports: opp.sports || [],
      compensation: { amount: opp.value || 0, type: 'flat' },
      deliverables: (opp.deliverables || []).map(d => ({ type: d.type, platform: d.platform, description: d.description })),
      status: singleAthlete ? 'active' : 'open',
      startDate: singleAthlete ? new Date() : undefined,
      isPublic: !singleAthlete
    });

    opp.linkedDeal = deal._id;
    opp.stage = 'active';
    opp.probability = STAGE_PROBABILITY.active;
    await opp.save();

    await CrmEvent.create({
      opportunity: opp._id, company: opp.company._id, owner: req.user._id,
      kind: 'note', body: `Converted to platform deal: ${deal.title}`
    });
    await Activity.create({
      user: req.user._id, type: 'deal_offer', title: 'Opportunity converted',
      message: `Created deal "${deal.title}" from CRM opportunity`, relatedDeal: deal._id
    });

    res.json({ opportunity: await opp.populate(OPP_POPULATE), dealId: deal._id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/opportunities/:id', async (req, res) => {
  try {
    const opp = await Opportunity.findOneAndDelete({ _id: req.params.id, owner: req.user._id });
    if (!opp) return res.status(404).json({ error: 'Opportunity not found' });
    await CrmEvent.deleteMany({ opportunity: opp._id });
    res.json({ message: 'Opportunity deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Timeline events ──────────────────────────────────────────────────────────
async function ownsOpp(id, userId) {
  return oid(id) && Opportunity.findOne({ _id: id, owner: userId });
}

router.get('/opportunities/:id/events', async (req, res) => {
  try {
    if (!(await ownsOpp(req.params.id, req.user._id))) return res.status(404).json({ error: 'Opportunity not found' });
    const events = await CrmEvent.find({ opportunity: req.params.id }).sort({ createdAt: -1 });
    res.json({ events });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/opportunities/:id/events', async (req, res) => {
  try {
    const opp = await ownsOpp(req.params.id, req.user._id);
    if (!opp) return res.status(404).json({ error: 'Opportunity not found' });
    const { kind, body, dueDate } = req.body;
    if (!['note', 'task', 'call', 'meeting'].includes(kind)) return res.status(400).json({ error: 'Invalid kind' });
    const event = await CrmEvent.create({
      opportunity: opp._id, company: opp.company, contact: opp.primaryContact,
      owner: req.user._id, kind, body: body || '',
      dueDate: kind === 'task' ? (dueDate || undefined) : undefined
    });
    res.status(201).json({ event });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/events/:id', async (req, res) => {
  try {
    const allowed = ['body', 'done', 'dueDate'];
    const updates = {};
    for (const k of allowed) if (req.body[k] !== undefined) updates[k] = req.body[k];
    const event = await CrmEvent.findOneAndUpdate(
      { _id: req.params.id, owner: req.user._id }, updates, { new: true }
    );
    if (!event) return res.status(404).json({ error: 'Event not found' });
    res.json({ event });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/events/:id', async (req, res) => {
  try {
    const event = await CrmEvent.findOneAndDelete({ _id: req.params.id, owner: req.user._id });
    if (!event) return res.status(404).json({ error: 'Event not found' });
    res.json({ message: 'Event deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Compose + log (and send when RESEND_API_KEY is set) an outreach email.
router.post('/opportunities/:id/email', async (req, res) => {
  try {
    const opp = await ownsOpp(req.params.id, req.user._id);
    if (!opp) return res.status(404).json({ error: 'Opportunity not found' });
    const { to, subject, body } = req.body;
    if (!to) return res.status(400).json({ error: 'recipient required' });

    const { status } = await sendEmail({ to, subject, html: (body || '').replace(/\n/g, '<br>') });

    const event = await CrmEvent.create({
      opportunity: opp._id, company: opp.company, contact: opp.primaryContact,
      owner: req.user._id, kind: 'email', body: body || '',
      emailTo: to, emailSubject: subject || '', emailStatus: status
    });
    if (opp.primaryContact) {
      await Contact.findOneAndUpdate(
        { _id: opp.primaryContact, owner: req.user._id },
        { lastContactedAt: new Date() }
      );
    }
    res.status(201).json({ event, status });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Leads (Salesforce-style front of funnel) ─────────────────────────────────
const LEAD_FIELDS = ['name', 'company', 'email', 'phone', 'title', 'sport', 'notes', 'tags', 'source', 'status', 'rating'];

router.get('/leads', async (req, res) => {
  try {
    const query = { owner: req.user._id };
    if (req.query.status && LEAD_STATUSES.includes(req.query.status)) query.status = req.query.status;
    const leads = await Lead.find(query).sort({ updatedAt: -1 });
    res.json({ leads });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/leads', async (req, res) => {
  try {
    if (!req.body.name) return res.status(400).json({ error: 'name required' });
    const data = { owner: req.user._id };
    for (const k of LEAD_FIELDS) if (req.body[k] !== undefined) data[k] = req.body[k];
    const lead = await Lead.create(data);
    res.status(201).json({ lead });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/leads/:id', async (req, res) => {
  try {
    const lead = await Lead.findOne({ _id: req.params.id, owner: req.user._id });
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    for (const k of LEAD_FIELDS) if (req.body[k] !== undefined) lead[k] = req.body[k];
    await lead.save(); // pre-save recomputes score
    res.json({ lead });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/leads/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    if (!LEAD_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const lead = await Lead.findOneAndUpdate(
      { _id: req.params.id, owner: req.user._id }, { status }, { new: true }
    );
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    res.json({ lead });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/leads/:id', async (req, res) => {
  try {
    const lead = await Lead.findOneAndDelete({ _id: req.params.id, owner: req.user._id });
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    res.json({ message: 'Lead deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Convert a lead into Company (Account) + Contact, optionally an Opportunity.
const OPP_SOURCES = ['inbound', 'referral', 'outbound', 'marketplace', 'other'];
router.post('/leads/:id/convert', async (req, res) => {
  try {
    const lead = await Lead.findOne({ _id: req.params.id, owner: req.user._id });
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    if (lead.status === 'converted' || lead.convertedCompany) {
      return res.status(400).json({ error: 'Lead already converted' });
    }

    const { createOpportunity, opportunityTitle, opportunityValue } = req.body;

    const company = await Company.create({
      name: lead.company || lead.name, type: 'brand', owner: req.user._id
    });
    const contact = await Contact.create({
      name: lead.name, email: lead.email, phone: lead.phone, title: lead.title,
      company: company._id, owner: req.user._id, notes: lead.notes
    });

    let opportunity = null;
    if (createOpportunity) {
      opportunity = await Opportunity.create({
        title: opportunityTitle || `${lead.company || lead.name} — Opportunity`,
        company: company._id, primaryContact: contact._id, owner: req.user._id,
        value: Number(opportunityValue) || 0,
        sports: lead.sport ? [lead.sport] : [],
        source: OPP_SOURCES.includes(lead.source) ? lead.source : 'other',
        stage: 'prospect', probability: STAGE_PROBABILITY.prospect, stageEnteredAt: new Date()
      });
    }

    lead.status = 'converted';
    lead.convertedAt = new Date();
    lead.convertedCompany = company._id;
    lead.convertedContact = contact._id;
    lead.convertedOpportunity = opportunity?._id || null;
    await lead.save();

    await Activity.create({
      user: req.user._id, type: 'deal_offer', title: 'Lead converted',
      message: `Converted lead "${lead.name}"${opportunity ? ' into an opportunity' : ''}`
    });

    res.json({
      lead,
      companyId: company._id,
      contactId: contact._id,
      opportunityId: opportunity?._id || null
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
