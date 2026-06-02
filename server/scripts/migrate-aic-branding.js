// One-time migration: rename leftover "AiC" seed users/data to "Digital NIL".
//
// Renames legacy seed/demo identities created before the Digital NIL rebrand so
// the deployed demo-login buttons (now @dnil.test) line up with existing rows and
// no orphaned @aic.* accounts linger.
//
//   email  @aic.test   -> @dnil.test
//   email  *.aic        -> *.dnil      (covers @athlete.aic / @brand.aic / @roster.aic)
//   agency 'AiC Sports'    -> 'Digital NIL Sports'
//   school 'AiC University'-> 'Digital NIL University'
//   company 'AiC Apparel'  -> 'Digital NIL Apparel'
//
// Safe by design:
//   * DRY-RUN by default — prints the plan and changes NOTHING. Pass --apply to write.
//   * Operates on the raw `users` collection, so no Mongoose pre-save hooks fire
//     (passwords are NOT re-hashed, lead scores etc. are untouched).
//   * Email rename is skipped (and reported) if the target email already exists,
//     so it can never trip the unique index or merge two accounts.
//   * Idempotent — re-running after a successful apply finds nothing to do.
//
// Usage (against Railway production env):
//   railway run node server/scripts/migrate-aic-branding.js            # dry run
//   railway run node server/scripts/migrate-aic-branding.js --apply    # commit

import mongoose from 'mongoose';

const APPLY = process.argv.includes('--apply');

const renameEmail = (email) => {
  if (typeof email !== 'string') return null;
  if (email.endsWith('@aic.test')) return email.slice(0, -'@aic.test'.length) + '@dnil.test';
  if (email.endsWith('.aic')) return email.slice(0, -'.aic'.length) + '.dnil';
  return null;
};

const FIELD_RENAMES = [
  { field: 'agency', from: 'AiC Sports', to: 'Digital NIL Sports' },
  { field: 'school', from: 'AiC University', to: 'Digital NIL University' },
  { field: 'company', from: 'AiC Apparel', to: 'Digital NIL Apparel' },
];

const main = async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri || /localhost|127\.0\.0\.1|placeholder|your-/i.test(uri)) {
    console.error('Refusing to run: MONGODB_URI is missing or looks like a placeholder/local URI.');
    console.error('Run this via `railway run` so the production Atlas URI is injected.');
    process.exit(1);
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
  const host = mongoose.connection.host;
  const dbName = mongoose.connection.name;
  console.log(`Connected to ${host} / db "${dbName}"`);
  console.log(APPLY ? '*** APPLY MODE — changes WILL be written ***' : '--- DRY RUN — no changes will be written (pass --apply to commit) ---');
  console.log('');

  const users = mongoose.connection.collection('users');

  // ---- 1. Email renames ----
  const candidates = await users
    .find({ $or: [{ email: /@aic\.test$/ }, { email: /\.aic$/ }] })
    .project({ email: 1 })
    .toArray();

  let renamed = 0, conflicts = 0;
  console.log(`Email renames — ${candidates.length} candidate(s):`);
  for (const u of candidates) {
    const next = renameEmail(u.email);
    if (!next) continue;
    const clash = await users.findOne({ email: next, _id: { $ne: u._id } }, { projection: { _id: 1 } });
    if (clash) {
      conflicts++;
      console.log(`  SKIP  ${u.email}  ->  ${next}   (target already exists — _id ${clash._id})`);
      continue;
    }
    console.log(`  ${APPLY ? 'RENAME' : 'would'}  ${u.email}  ->  ${next}`);
    if (APPLY) {
      await users.updateOne({ _id: u._id }, { $set: { email: next } });
      renamed++;
    }
  }

  // ---- 2. Demo string fields ----
  console.log('');
  console.log('Field renames:');
  let fieldUpdates = 0;
  for (const { field, from, to } of FIELD_RENAMES) {
    const count = await users.countDocuments({ [field]: from });
    console.log(`  ${field}: "${from}" -> "${to}"   (${count} doc(s))`);
    if (APPLY && count > 0) {
      const r = await users.updateMany({ [field]: from }, { $set: { [field]: to } });
      fieldUpdates += r.modifiedCount;
    }
  }

  console.log('');
  if (APPLY) {
    console.log(`Done. Emails renamed: ${renamed}, conflicts skipped: ${conflicts}, field updates: ${fieldUpdates}.`);
  } else {
    console.log(`Dry run complete. Would rename ${candidates.length - conflicts} email(s) (${conflicts} conflict(s)). Re-run with --apply to commit.`);
  }

  await mongoose.disconnect();
  process.exit(0);
};

main().catch(async (err) => {
  console.error('Migration failed:', err.message);
  try { await mongoose.disconnect(); } catch { /* ignore */ }
  process.exit(1);
});
