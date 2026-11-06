const router = require('express').Router();
const crypto = require('crypto');
const { z } = require('zod');
const db = require('../db');
const loc = require('../services/locationService');
const trips = require('../services/tripService');
const { authenticate, requireRole } = require('../middleware/auth');
const { HttpError, wrap, normalizePhone } = require('../utils');

router.use(authenticate, requireRole('ADMIN'));

const audit = (actor, action, target) => db.query(`INSERT INTO audit_log (actor_id, action, target) VALUES ($1,$2,$3)`, [actor, action, String(target)]);

// ---- driver KYC ----
router.get('/drivers', wrap(async (req, res) => {
  const status = z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional().parse(req.query.status);
  const { rows } = await db.query(
    `SELECT u.id, u.name, u.phone, u.status, dp.* FROM users u JOIN driver_profiles dp ON dp.user_id=u.id
      WHERE ($1::text IS NULL OR dp.verification_status=$1) ORDER BY u.id DESC LIMIT 200`, [status ?? null]);
  res.json(rows);
}));

router.post('/drivers/:id/review', wrap(async (req, res) => {
  const b = z.object({ approve: z.boolean(), reason: z.string().max(300).optional() }).parse(req.body);
  if (!b.approve && !b.reason) throw new HttpError(400, 'A reason is required to reject', 'REASON_REQUIRED');
  if (b.approve) {
    const p = (await db.query(`SELECT id_url, license_url, good_conduct_url FROM driver_profiles WHERE user_id=$1`, [req.params.id])).rows[0];
    if (!p?.id_url || !p.license_url || !p.good_conduct_url) throw new HttpError(422, 'Driver has not submitted all documents', 'DOCS_MISSING');
  }
  await db.query(`UPDATE driver_profiles SET verification_status=$2, rejection_reason=$3, online=CASE WHEN $2='APPROVED' THEN online ELSE false END WHERE user_id=$1`,
    [req.params.id, b.approve ? 'APPROVED' : 'REJECTED', b.approve ? null : b.reason]);
  await audit(req.user.id, b.approve ? 'DRIVER_APPROVED' : 'DRIVER_REJECTED', req.params.id);
  res.json({ ok: true });
}));

router.post('/users/:id/suspend', wrap(async (req, res) => {
  const { suspend } = z.object({ suspend: z.boolean() }).parse(req.body);
  await db.query(`UPDATE users SET status=$2 WHERE id=$1 AND role<>'ADMIN'`, [req.params.id, suspend ? 'SUSPENDED' : 'ACTIVE']);
  if (suspend) await db.query(`UPDATE driver_profiles SET online=false WHERE user_id=$1`, [req.params.id]);
  await audit(req.user.id, suspend ? 'USER_SUSPENDED' : 'USER_REINSTATED', req.params.id);
  res.json({ ok: true });
}));

// ---- live ops ----
router.get('/trips/live', wrap(async (_req, res) => {
  const { rows } = await db.query(
    `SELECT * FROM trips WHERE status IN ('MATCHING','ACCEPTED','DRIVER_EN_ROUTE','ARRIVED','IN_PROGRESS') ORDER BY id DESC LIMIT 200`);
  res.json({ trips: rows, drivers: await loc.store.all() });
}));

router.get('/trips', wrap(async (req, res) => {
  const status = req.query.status ? String(req.query.status) : null;
  const { rows } = await db.query(`SELECT * FROM trips WHERE ($1::text IS NULL OR status=$1) ORDER BY id DESC LIMIT 200`, [status]);
  res.json(rows);
}));

router.get('/trips/:id/events', wrap(async (req, res) => {
  const ev = await db.query(`SELECT * FROM trip_events WHERE trip_id=$1 ORDER BY id`, [req.params.id]);
  const ph = await db.query(`SELECT * FROM trip_photos WHERE trip_id=$1 ORDER BY id`, [req.params.id]);
  res.json({ events: ev.rows, photos: ph.rows });
}));

// ---- disputes & refunds ----
router.post('/trips/:id/dispute', wrap(async (req, res) => {
  const { note } = z.object({ note: z.string().max(500) }).parse(req.body);
  const cur = await trips.getTrip(req.params.id);
  const t = await trips.transition(cur.id, 'DISPUTED', { actorId: req.user.id, payload: { note } });
  await audit(req.user.id, 'TRIP_DISPUTED', cur.id);
  res.json(await trips.present(t, 'ADMIN'));
}));

router.post('/trips/:id/refund', wrap(async (req, res) => {
  const cur = await trips.getTrip(req.params.id);
  const t = await db.tx(async (c) => {
    if (cur.status !== 'DISPUTED') throw new HttpError(409, 'Only disputed trips can be refunded', 'BAD_STATE');
    // Claw back the driver's share if it was credited and still in the wallet.
    await c.query(`UPDATE driver_profiles SET wallet_balance_kes = GREATEST(0, wallet_balance_kes - $2) WHERE user_id=$1`, [cur.driver_id, cur.driver_earning_kes || 0]);
    const r = await c.query(`UPDATE trips SET status='REFUNDED' WHERE id=$1 AND status='DISPUTED' RETURNING *`, [cur.id]);
    await c.query(`INSERT INTO trip_events (trip_id,type,actor_id) VALUES ($1,'REFUNDED',$2)`, [cur.id, req.user.id]);
    return r.rows[0];
  });
  await audit(req.user.id, 'TRIP_REFUNDED', cur.id);
  // The M-Pesa reversal itself is performed from the Safaricom portal / Reversal API; recorded here for reconciliation.
  res.json({ ...(await trips.present(t, 'ADMIN')), note: 'Refund recorded. Issue the M-Pesa reversal for the payment receipt.' });
}));

// ---- SOS ----
router.get('/sos', wrap(async (_req, res) => {
  const { rows } = await db.query(
    `SELECT s.*, u.name, u.phone FROM sos_alerts s JOIN users u ON u.id=s.user_id ORDER BY (s.status='OPEN') DESC, s.id DESC LIMIT 100`);
  res.json(rows);
}));
router.post('/sos/:id/status', wrap(async (req, res) => {
  const { status } = z.object({ status: z.enum(['ACKNOWLEDGED', 'RESOLVED']) }).parse(req.body);
  await db.query(`UPDATE sos_alerts SET status=$2, resolved_at = CASE WHEN $2='RESOLVED' THEN now() ELSE NULL END WHERE id=$1`, [req.params.id, status]);
  await audit(req.user.id, `SOS_${status}`, req.params.id);
  res.json({ ok: true });
}));

// ---- config: zones, promos, venues ----
router.get('/zones', wrap(async (_req, res) => res.json((await db.query(`SELECT * FROM service_zones ORDER BY id`)).rows)));
router.put('/zones/:id', wrap(async (req, res) => {
  const b = z.object({ surgeMultiplier: z.number().min(1).max(5).optional(), active: z.boolean().optional(), radiusKm: z.number().min(0.5).max(30).optional() }).parse(req.body);
  await db.query(`UPDATE service_zones SET surge_multiplier=coalesce($2,surge_multiplier), active=coalesce($3,active), radius_km=coalesce($4,radius_km) WHERE id=$1`,
    [req.params.id, b.surgeMultiplier ?? null, b.active ?? null, b.radiusKm ?? null]);
  await audit(req.user.id, 'ZONE_UPDATED', req.params.id);
  res.json({ ok: true });
}));
router.post('/zones', wrap(async (req, res) => {
  const b = z.object({ name: z.string().min(2), lat: z.number(), lng: z.number(), radiusKm: z.number().min(0.5).max(30) }).parse(req.body);
  const { rows } = await db.query(`INSERT INTO service_zones (name, center_lat, center_lng, radius_km) VALUES ($1,$2,$3,$4) RETURNING *`, [b.name, b.lat, b.lng, b.radiusKm]);
  res.status(201).json(rows[0]);
}));

router.get('/promos', wrap(async (_req, res) => res.json((await db.query(`SELECT * FROM promo_codes ORDER BY code`)).rows)));
router.post('/promos', wrap(async (req, res) => {
  const b = z.object({ code: z.string().regex(/^[A-Za-z0-9]{3,20}$/), percentOff: z.number().int().min(0).max(100).default(0),
    flatOffKes: z.number().int().min(0).default(0), maxUses: z.number().int().positive().optional() }).parse(req.body);
  await db.query(`INSERT INTO promo_codes (code, percent_off, flat_off_kes, max_uses) VALUES (upper($1),$2,$3,$4)`, [b.code, b.percentOff, b.flatOffKes, b.maxUses ?? null]);
  res.status(201).json({ ok: true });
}));

router.post('/venues', wrap(async (req, res) => {
  const b = z.object({ name: z.string().min(2), lat: z.number(), lng: z.number(), contactPerson: z.string().optional(), staffPhone: z.string().optional() }).parse(req.body);
  const code = crypto.randomBytes(4).toString('hex').toUpperCase();
  const v = (await db.query(`INSERT INTO venues (name, lat, lng, contact_person, referral_code) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [b.name, b.lat, b.lng, b.contactPerson ?? null, code])).rows[0];
  if (b.staffPhone) {
    const phone = normalizePhone(b.staffPhone);
    if (!phone) throw new HttpError(400, 'Invalid staff phone', 'BAD_PHONE');
    const u = (await db.query(`INSERT INTO users (phone, role) VALUES ($1,'VENUE') ON CONFLICT (phone) DO UPDATE SET role='VENUE' RETURNING id`, [phone])).rows[0];
    await db.query(`INSERT INTO venue_staff (user_id, venue_id) VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET venue_id=$2`, [u.id, v.id]);
  }
  res.status(201).json(v);
}));
router.get('/venues', wrap(async (_req, res) => res.json((await db.query(`SELECT * FROM venues ORDER BY id`)).rows)));

// ---- analytics ----
router.get('/analytics', wrap(async (_req, res) => {
  const q = (sql) => db.query(sql).then((r) => r.rows);
  const [totals, daily, util] = await Promise.all([
    q(`SELECT count(*)::int AS total_trips,
              count(*) FILTER (WHERE status='PAID')::int AS paid_trips,
              count(*) FILTER (WHERE status LIKE 'CANCELLED%')::int AS cancelled,
              count(*) FILTER (WHERE status='NO_DRIVER_FOUND')::int AS no_driver,
              coalesce(sum(final_fare_kes) FILTER (WHERE status='PAID'),0)::float AS gross_kes,
              coalesce(sum(commission_kes) FILTER (WHERE status='PAID'),0)::float AS revenue_kes,
              coalesce(avg(final_fare_kes) FILTER (WHERE status='PAID'),0)::float AS avg_fare_kes FROM trips`),
    q(`SELECT to_char(date_trunc('day', requested_at AT TIME ZONE 'Africa/Nairobi'),'YYYY-MM-DD') AS day,
              count(*)::int AS trips, coalesce(sum(final_fare_kes) FILTER (WHERE status='PAID'),0)::float AS gross_kes
         FROM trips WHERE requested_at > now() - interval '14 days' GROUP BY 1 ORDER BY 1`),
    q(`SELECT (SELECT count(*) FROM driver_profiles WHERE online)::int AS online_drivers,
              (SELECT count(*) FROM driver_profiles WHERE verification_status='APPROVED')::int AS approved_drivers,
              (SELECT count(*) FROM driver_profiles WHERE verification_status='PENDING')::int AS pending_drivers,
              (SELECT count(*) FROM sos_alerts WHERE status='OPEN')::int AS open_sos`),
  ]);
  const t = totals[0];
  res.json({ ...t, cancellationRate: t.total_trips ? +(t.cancelled / t.total_trips).toFixed(3) : 0, daily, ...util[0] });
}));

module.exports = router;
