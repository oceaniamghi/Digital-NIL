import 'dotenv/config';
import mongoose from 'mongoose';
import SystemSetting from '../models/SystemSetting.js';

// Owner CLI for the kill switch — run from the Railway shell (or locally) where
// MONGODB_URI is set. Talks straight to the DB, no running server required.
//
//   npm run license -- status
//   npm run license -- lock "Non-payment — invoice #123 overdue"
//   npm run license -- unlock
//   npm run license -- paid-through 2026-12-31   (omit date to clear it)
//   npm run license -- seat-limit 30

const [, , cmd, ...rest] = process.argv;

const usage = () => {
  console.log('Usage: npm run license -- <status|lock [reason]|unlock|paid-through [ISO date]|seat-limit <n>>');
};

const main = async () => {
  if (!cmd) { usage(); process.exit(1); }

  const uri = process.env.MONGODB_URI;
  if (!uri || /username:password@cluster\.mongodb\.net/i.test(uri)) {
    console.error('MONGODB_URI is not set to a real database. This CLI edits the persistent license record and needs the production DB.');
    process.exit(1);
  }
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
  const doc = await SystemSetting.getSingleton();

  switch (cmd) {
    case 'status':
      break;
    case 'lock':
      doc.disabled = true;
      doc.disabledReason = rest.join(' ') || 'Service suspended for non-payment.';
      break;
    case 'unlock':
      doc.disabled = false;
      doc.disabledReason = '';
      break;
    case 'paid-through': {
      if (!rest[0]) { doc.paidThrough = null; break; }
      const d = new Date(rest[0]);
      if (isNaN(d.getTime())) { console.error('Invalid date:', rest[0]); process.exit(1); }
      doc.paidThrough = d;
      break;
    }
    case 'seat-limit': {
      const n = Number(rest[0]);
      if (!Number.isFinite(n) || n < 1) { console.error('Invalid seat limit:', rest[0]); process.exit(1); }
      doc.seatLimit = Math.floor(n);
      break;
    }
    default:
      usage();
      process.exit(1);
  }

  if (cmd !== 'status') {
    doc.updatedAt = new Date();
    await doc.save();
  }

  const expired = doc.paidThrough ? Date.now() > new Date(doc.paidThrough).getTime() : false;
  console.log('License state:');
  console.log('  disabled    :', doc.disabled);
  console.log('  reason      :', doc.disabledReason || '(none)');
  console.log('  paidThrough :', doc.paidThrough ? doc.paidThrough.toISOString() : '(none)', expired ? '(EXPIRED)' : '');
  console.log('  seatLimit   :', doc.seatLimit);
  console.log('  locked now  :', doc.disabled || expired);
  if (process.env.APP_DISABLED && /^(1|true|yes|on)$/i.test(process.env.APP_DISABLED)) {
    console.log('  NOTE: APP_DISABLED is set in this environment — the live app is hard-locked regardless of the DB flag above.');
  }

  await mongoose.disconnect();
  process.exit(0);
};

main().catch(err => { console.error(err.message); process.exit(1); });
