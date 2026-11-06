// Minimal fixed-window in-memory limiter. Use the gateway/Redis limiter in multi-node deployments.
const { HttpError } = require('../utils');

function rateLimit({ windowMs, max, key = (req) => req.ip }) {
  const hits = new Map();
  setInterval(() => { const n = Date.now(); for (const [k, v] of hits) if (v.reset < n) hits.delete(k); }, windowMs).unref();
  return (req, _res, next) => {
    const k = key(req);
    const now = Date.now();
    let e = hits.get(k);
    if (!e || e.reset < now) { e = { count: 0, reset: now + windowMs }; hits.set(k, e); }
    if (++e.count > max) return next(new HttpError(429, 'Too many requests', 'RATE_LIMITED'));
    next();
  };
}

module.exports = { rateLimit };
