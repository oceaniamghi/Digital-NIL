import mongoose from 'mongoose';
import SystemSetting from '../models/SystemSetting.js';

// Effective lock state = (env hard-kill) OR (DB disabled flag) OR (paid-through expired).
// The env var is the vendor's nuclear override: it works even if the DB is down and
// cannot be undone by the customer's own admins. Result is cached briefly so the gate
// runs on every API request without a DB round-trip each time.

const TRUE = /^(1|true|yes|on)$/i;
const TTL_MS = 15000;
let cache = { state: null, at: 0 };

// Hard env override — flip APP_DISABLED=true in Railway and redeploy for an instant lock.
export const envDisabled = () => TRUE.test(process.env.APP_DISABLED || '');

// Optional env fallback paid-through (ISO date). The DB value wins when present.
const envPaidThrough = () => {
  const v = process.env.PAID_THROUGH;
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
};

const envSeatLimit = () => {
  const n = Number(process.env.SEAT_LIMIT);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
};

export async function getLicenseState({ fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && cache.state && now - cache.at < TTL_MS) return cache.state;

  let db = null;
  if (mongoose.connection.readyState === 1) {
    try { db = await SystemSetting.getSingleton(); } catch { /* DB hiccup — fall back to env only */ }
  }

  const paidThrough = db?.paidThrough || envPaidThrough();
  const expired = paidThrough ? now > new Date(paidThrough).getTime() : false;
  const hardOff = envDisabled();
  const dbOff = !!db?.disabled;
  const locked = hardOff || dbOff || expired;

  let reason = '';
  if (hardOff) reason = 'This service has been suspended. Please contact your account manager.';
  else if (dbOff) reason = db.disabledReason || 'This service has been suspended. Please contact your account manager.';
  else if (expired) reason = 'This subscription has expired. Please contact your account manager to restore access.';

  const state = {
    locked,
    reason,
    expired,
    paidThrough: paidThrough || null,
    seatLimit: db?.seatLimit ?? envSeatLimit() ?? 50,
    plan: db?.plan || 'standard',
    customerName: db?.customerName || '',
    source: hardOff ? 'env' : dbOff ? 'db' : expired ? 'expiry' : 'active'
  };
  cache = { state, at: now };
  return state;
}

export function invalidateLicenseCache() {
  cache = { state: null, at: 0 };
}
