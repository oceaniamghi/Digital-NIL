import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import { planCan, minPlanForCap } from '../lib/plans.js';

export const requireAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }
    const token = authHeader.slice(7);
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.userId).select('-password');
    if (!user) return res.status(401).json({ error: 'User not found' });
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

export const requireRole = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  next();
};

// Shared 402 "Upgrade required" contract. Every plan-gated feature returns this so
// the client can reuse one global upgrade prompt (see signalUpgrade). `min` is the
// cheapest tier that unlocks the feature, surfaced to word the prompt.
export const upgradeRequired = (res, message, min) => res.status(402).json({
  error: 'Upgrade required',
  message,
  upgrade: { plan: min ? min.key : undefined, planName: min ? min.name : undefined, message }
});

// Gate a feature behind a plan CAPABILITY (e.g. 'directOffers', 'recruitmentTrips',
// 'outreachEmail', 'mediaKitPdf'). Role-aware: the upgrade prompt names the cheapest
// tier in the user's own role ladder that unlocks it.
export const requireCap = (cap, label) => (req, res, next) => {
  if (planCan(req.user, cap)) return next();
  const min = minPlanForCap(req.user.role, cap);
  return upgradeRequired(res,
    `${label} ${min ? `is available on the ${min.name} plan and up` : 'requires a higher plan'}. Upgrade to unlock it.`,
    min);
};
