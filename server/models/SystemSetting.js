import mongoose from 'mongoose';

// Single source of truth for the vendor-controlled license/kill-switch state.
// One document (key: 'license'). The owner toggles these fields remotely; an
// expired paidThrough or a true `disabled` flag locks the whole app.
const systemSettingSchema = new mongoose.Schema({
  key: { type: String, default: 'license', unique: true },
  disabled: { type: Boolean, default: false },        // manual kill switch
  disabledReason: { type: String, default: '' },
  paidThrough: { type: Date, default: null },          // null = no expiry enforced
  seatLimit: { type: Number, default: 50 },            // max billable staff seats
  plan: { type: String, default: 'standard' },
  customerName: { type: String, default: '' },
  updatedAt: { type: Date, default: Date.now }
}, { minimize: false });

systemSettingSchema.statics.getSingleton = async function () {
  let doc = await this.findOne({ key: 'license' });
  if (!doc) doc = await this.create({ key: 'license' });
  return doc;
};

export default mongoose.model('SystemSetting', systemSettingSchema);
