import mongoose from 'mongoose';

// One entry on a record's activity timeline: a note, task, logged/sent email,
// stage change, call, or meeting. Polymorphic — usually tied to an opportunity.
const crmEventSchema = new mongoose.Schema({
  opportunity: { type: mongoose.Schema.Types.ObjectId, ref: 'Opportunity', index: true },
  company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company' },
  contact: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact' },
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

  kind: { type: String, enum: ['note', 'task', 'email', 'stage_change', 'call', 'meeting'], required: true },
  body: { type: String, default: '' },

  // task
  dueDate: { type: Date },
  done: { type: Boolean, default: false },

  // email
  emailTo: { type: String, default: '' },
  emailSubject: { type: String, default: '' },
  emailStatus: { type: String, enum: ['logged', 'sent', 'failed'], default: 'logged' },

  // stage_change
  fromStage: { type: String, default: '' },
  toStage: { type: String, default: '' },

  createdAt: { type: Date, default: Date.now }
});

export default mongoose.model('CrmEvent', crmEventSchema);
