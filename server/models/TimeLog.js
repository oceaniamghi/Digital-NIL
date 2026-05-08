import mongoose from 'mongoose';

// R&D Credit Time-Tracking Model
// Substantiates Section 41 (federal) and California R&D credit QRE claims.
// Each log entry maps to a qualified research activity (QRA) under the 4-part test:
//   1. Technological uncertainty  2. Process of experimentation
//   3. Technological in nature    4. Qualified purpose (new/improved functionality)

const timeLogSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

  date: { type: Date, required: true },
  hours: { type: Number, required: true, min: 0.25, max: 24 },

  // Feature / component being developed or researched
  feature: {
    type: String,
    required: true,
    enum: [
      'deal-matching-algorithm',
      'media-kit-generator',
      'sponsor-portal',
      'analytics-dashboard',
      'real-time-notifications',
      'content-approval-workflow',
      'athlete-profile-engine',
      'api-infrastructure',
      'database-schema',
      'authentication-security',
      'mobile-responsive-ui',
      'roster-management',
      'campaign-management',
      'other'
    ]
  },

  // Activity type for QRA classification
  activityType: {
    type: String,
    required: true,
    enum: [
      'architecture-design',     // Designing system architecture / data models
      'prototype-development',   // Building proof-of-concept or experimental builds
      'algorithm-development',   // Writing algorithms, business logic, matching engines
      'testing-debugging',       // Unit/integration testing, debugging novel functionality
      'performance-optimization',// Benchmarking and resolving performance uncertainties
      'security-research',       // Auth, token security, access control research
      'ui-ux-experimentation',   // Front-end experiments to resolve UX uncertainties
      'infrastructure-research', // Cloud, DB, or deployment architecture research
      'documentation',           // Technical specs, API docs (non-QRA — tracked for completeness)
      'meetings-planning',       // Non-QRA admin time
    ]
  },

  // Whether this entry constitutes a Qualified Research Activity
  isQRA: { type: Boolean, default: true },

  // Brief description of the technological uncertainty being resolved
  uncertainty: { type: String, default: '', maxlength: 1000 },

  // What was actually done / hypothesis tested
  description: { type: String, required: true, maxlength: 2000 },

  // Outcome or finding (optional — strengthens substantiation)
  outcome: { type: String, default: '', maxlength: 1000 },

  // Contractor or employee identifier (for wage/contract allocation)
  workerType: { type: String, enum: ['employee', 'contractor'], default: 'contractor' },
  workerEntity: { type: String, default: 'United Gates LLC' },

  // Quarter tag for easy reporting (e.g. "2026-Q1")
  quarter: { type: String },

  createdAt: { type: Date, default: Date.now }
});

// Auto-compute quarter from date before save
timeLogSchema.pre('save', function (next) {
  if (this.date) {
    const d = new Date(this.date);
    const q = Math.ceil((d.getMonth() + 1) / 3);
    this.quarter = `${d.getFullYear()}-Q${q}`;
  }
  next();
});

export default mongoose.model('TimeLog', timeLogSchema);
