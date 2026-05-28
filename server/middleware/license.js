import { getLicenseState } from '../lib/license.js';

// Gate for /api/* (mounted after the always-reachable health/system/owner routes).
// When the license is locked, every other API call returns 503 { locked, reason }
// so the client can drop into its lock screen. Defense-in-depth: the owner/system/
// health paths are also explicitly exempted here in case mount order ever changes.
const isExempt = (p) =>
  p === '/health' ||
  p === '/system/status' || p.startsWith('/system/') ||
  p === '/owner' || p.startsWith('/owner/');

export const licenseGate = async (req, res, next) => {
  if (isExempt(req.path)) return next();
  try {
    const state = await getLicenseState();
    if (state.locked) {
      return res.status(503).json({ locked: true, reason: state.reason || 'Service unavailable' });
    }
  } catch {
    // Never let an unexpected error here lock out a paying customer — fail open.
    // (A real env/DB lock is evaluated above and does not throw.)
  }
  next();
};
