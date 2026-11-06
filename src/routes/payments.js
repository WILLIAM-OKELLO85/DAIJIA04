const router = require('express').Router();
const crypto = require('crypto');
const { z } = require('zod');
const config = require('../config');
const payments = require('../services/paymentService');
const mpesa = require('../services/mpesa');
const { authenticate, requireRole } = require('../middleware/auth');
const { HttpError, wrap, normalizePhone } = require('../utils');
const db = require('../db');

router.post('/mpesa/stk-push', authenticate, requireRole('CLIENT'), wrap(async (req, res) => {
  const b = z.object({ tripId: z.number().int().positive(), phone: z.string().optional() }).parse(req.body);
  const phone = b.phone ? normalizePhone(b.phone) : undefined;
  if (b.phone && !phone) throw new HttpError(400, 'Invalid phone', 'BAD_PHONE');
  res.status(202).json(await payments.initiate(req.user.id, b.tripId, phone));
}));

router.get('/trip/:tripId', authenticate, wrap(async (req, res) => {
  const { rows } = await db.query(
    `SELECT p.id, p.status, p.amount_kes, p.mpesa_receipt, p.failure_reason FROM payments p JOIN trips t ON t.id=p.trip_id
      WHERE p.trip_id=$1 AND (t.client_id=$2 OR t.driver_id=$2 OR $3='ADMIN') ORDER BY p.id DESC LIMIT 1`,
    [req.params.tripId, req.user.id, req.user.role]);
  res.json(rows[0] || null);
}));

// Daraja has no request signing, so we authenticate callbacks with a secret in the URL we registered.
function callbackAuth(req, _res, next) {
  const given = Buffer.from(String(req.query.secret || ''));
  const want = Buffer.from(config.mpesa.callbackSecret);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return next(new HttpError(403, 'Forbidden', 'FORBIDDEN'));
  next();
}

router.post('/mpesa/callback', callbackAuth, wrap(async (req, res) => {
  const parsed = mpesa.parseCallback(req.body);
  if (parsed) await payments.handleCallback(parsed);
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' }); // always ack so Safaricom stops retrying
}));
router.post('/mpesa/b2c-result', callbackAuth, wrap(async (req, res) => { await payments.handleB2CResult(req.body); res.json({ ResultCode: 0, ResultDesc: 'Accepted' }); }));
router.post('/mpesa/b2c-timeout', callbackAuth, (_req, res) => res.json({ ResultCode: 0, ResultDesc: 'Accepted' }));

module.exports = router;
