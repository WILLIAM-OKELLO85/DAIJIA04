const jwt = require('jsonwebtoken');
const config = require('../config');
const { HttpError } = require('../utils');

const signAccess = (user) =>
  jwt.sign({ sub: String(user.id), role: user.role }, config.jwt.accessSecret, { expiresIn: config.jwt.accessTtl });

const verifyAccess = (token) => jwt.verify(token, config.jwt.accessSecret);

function authenticate(req, _res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return next(new HttpError(401, 'Missing token', 'NO_TOKEN'));
  try {
    const p = verifyAccess(token);
    req.user = { id: Number(p.sub), role: p.role };
    next();
  } catch {
    next(new HttpError(401, 'Invalid or expired token', 'BAD_TOKEN'));
  }
}

const requireRole = (...roles) => (req, _res, next) =>
  roles.includes(req.user?.role) ? next() : next(new HttpError(403, 'Forbidden', 'FORBIDDEN'));

module.exports = { signAccess, verifyAccess, authenticate, requireRole };
