const router = require('express').Router();
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const db = require('../db');
const config = require('../config');
const { requestOtp, verifyOtp } = require('../services/otp');
const { signAccess, authenticate } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const { HttpError, wrap, normalizePhone } = require('../utils');

const phoneSchema = z.string().transform((s, ctx) => {
  const p = normalizePhone(s);
  if (!p) ctx.addIssue({ code: 'custom', message: 'Enter a valid Kenyan phone number' });
  return p;
});

// Per-IP ceiling is generous because carrier-grade NAT puts many Kenyan users behind one IP;
// the real brute-force protection is per phone (30s resend cooldown, 5 attempts per code).
const limiter = rateLimit({ windowMs: 60_000, max: Number(process.env.RATE_LIMIT_AUTH_PER_MIN || 120) });

router.post('/otp/request', limiter, wrap(async (req, res) => {
  const { phone } = z.object({ phone: phoneSchema }).parse(req.body);
  res.json({ ok: true, ...(await requestOtp(phone)) });
}));

const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

async function issueTokens(user) {
  const refresh = jwt.sign({ sub: String(user.id), jti: crypto.randomUUID() }, config.jwt.refreshSecret, { expiresIn: `${config.jwt.refreshTtlDays}d` });
  await db.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1,$2, now() + ($3 || ' days')::interval)`,
    [user.id, hashToken(refresh), config.jwt.refreshTtlDays]);
  return { accessToken: signAccess(user), refreshToken: refresh };
}

router.post('/otp/verify', limiter, wrap(async (req, res) => {
  const body = z.object({
    phone: phoneSchema, code: z.string().regex(/^\d{6}$/),
    name: z.string().trim().min(2).max(80).optional(),
    role: z.enum(['CLIENT', 'DRIVER']).default('CLIENT'),
  }).parse(req.body);
  await verifyOtp(body.phone, body.code);

  let { rows } = await db.query(`SELECT * FROM users WHERE phone=$1`, [body.phone]);
  let user = rows[0];
  let isNew = false;
  if (!user) {
    const role = config.adminPhones.includes(body.phone) ? 'ADMIN' : body.role;
    ({ rows } = await db.query(`INSERT INTO users (phone, name, role) VALUES ($1,$2,$3) RETURNING *`, [body.phone, body.name ?? null, role]));
    user = rows[0];
    isNew = true;
    if (role === 'DRIVER') await db.query(`INSERT INTO driver_profiles (user_id) VALUES ($1)`, [user.id]);
  } else if (body.name && !user.name) {
    await db.query(`UPDATE users SET name=$2 WHERE id=$1`, [user.id, body.name]);
    user.name = body.name;
  }
  if (user.status !== 'ACTIVE') throw new HttpError(403, 'Account suspended', 'SUSPENDED');
  res.json({ ...(await issueTokens(user)), user: { id: user.id, phone: user.phone, name: user.name, role: user.role }, isNew });
}));

router.post('/refresh', wrap(async (req, res) => {
  const { refreshToken } = z.object({ refreshToken: z.string() }).parse(req.body);
  let p;
  try { p = jwt.verify(refreshToken, config.jwt.refreshSecret); } catch { throw new HttpError(401, 'Invalid refresh token', 'BAD_TOKEN'); }
  // rotate: revoke the used token, issue a new pair
  const used = await db.query(
    `UPDATE refresh_tokens SET revoked=true WHERE token_hash=$1 AND revoked=false AND expires_at > now() RETURNING user_id`, [hashToken(refreshToken)]);
  if (!used.rows[0]) throw new HttpError(401, 'Refresh token already used or expired', 'BAD_TOKEN');
  const { rows } = await db.query(`SELECT * FROM users WHERE id=$1 AND status='ACTIVE'`, [p.sub]);
  if (!rows[0]) throw new HttpError(401, 'Account unavailable', 'BAD_TOKEN');
  res.json(await issueTokens(rows[0]));
}));

router.post('/logout', authenticate, wrap(async (req, res) => {
  await db.query(`UPDATE refresh_tokens SET revoked=true WHERE user_id=$1`, [req.user.id]);
  res.json({ ok: true });
}));

router.get('/me', authenticate, wrap(async (req, res) => {
  const { rows } = await db.query(`SELECT id, phone, name, role, language FROM users WHERE id=$1`, [req.user.id]);
  const contacts = await db.query(`SELECT id, contact_name, contact_phone FROM emergency_contacts WHERE user_id=$1`, [req.user.id]);
  res.json({ ...rows[0], emergencyContacts: contacts.rows });
}));

router.patch('/me', authenticate, wrap(async (req, res) => {
  const b = z.object({ name: z.string().trim().min(2).max(80).optional(), language: z.enum(['en', 'sw']).optional() }).parse(req.body);
  await db.query(`UPDATE users SET name=coalesce($2,name), language=coalesce($3,language) WHERE id=$1`, [req.user.id, b.name ?? null, b.language ?? null]);
  res.json({ ok: true });
}));

router.post('/emergency-contacts', authenticate, wrap(async (req, res) => {
  const b = z.object({ name: z.string().trim().min(1).max(60), phone: phoneSchema }).parse(req.body);
  const n = (await db.query(`SELECT count(*)::int n FROM emergency_contacts WHERE user_id=$1`, [req.user.id])).rows[0].n;
  if (n >= 5) throw new HttpError(422, 'Maximum 5 emergency contacts', 'LIMIT');
  const { rows } = await db.query(`INSERT INTO emergency_contacts (user_id, contact_name, contact_phone) VALUES ($1,$2,$3) RETURNING id, contact_name, contact_phone`, [req.user.id, b.name, b.phone]);
  res.status(201).json(rows[0]);
}));

router.delete('/emergency-contacts/:id', authenticate, wrap(async (req, res) => {
  await db.query(`DELETE FROM emergency_contacts WHERE id=$1 AND user_id=$2`, [req.params.id, req.user.id]);
  res.json({ ok: true });
}));

module.exports = router;
