import mongoose from 'mongoose';

// An NCAA recruiting-calendar window for a given sport + division. The four period
// types govern what a coach may do (see lib/recruiting.js for the action matrix):
//
//   contact     — calls, off-campus contact, official/unofficial visits all allowed
//   evaluation  — coaches may evaluate/assess but NOT have off-campus contact
//   quiet        — contact only on the coach's own campus; no off-campus, no evals
//   dead         — NO in-person contact or evaluation anywhere (calls/writing only,
//                  and this app blocks coach-initiated messaging during a dead period)
//
// Admin-editable via /api/admin/recruiting-periods so the calendar can be kept
// current each year without a code change. Reference (rules vary by sport/year):
// https://www.ncsasports.org/ncaa-eligibility-center/recruiting-rules/recruiting-calendar

export const PERIOD_TYPES = ['contact', 'evaluation', 'quiet', 'dead'];

const recruitingPeriodSchema = new mongoose.Schema({
  sport: { type: String, required: true, trim: true },          // e.g. "Football"
  division: { type: String, enum: ['D1', 'D2', 'D3', 'NAIA', 'JUCO'], default: 'D1' },
  type: { type: String, enum: PERIOD_TYPES, required: true },
  label: { type: String, default: '' },                         // human note, e.g. "Spring evaluation"
  startDate: { type: Date, required: true },
  endDate: { type: Date, required: true },
  year: { type: Number },                                       // recruiting class year this applies to
  active: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

recruitingPeriodSchema.index({ sport: 1, division: 1, startDate: 1 });

export default mongoose.model('RecruitingPeriod', recruitingPeriodSchema);
