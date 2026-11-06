const router = require('express').Router();
const { z } = require('zod');
const db = require('../db');
const config = require('../config');
const loc = require('../services/locationService');
const trips = require('../services/tripService');
const payments = require('../services/paymentService');
const { authenticate, requireRole } = require('../middleware/auth');
const { HttpError, wrap } = require('../utils');

router.use(authenticate);

router.get('/me', requireRole('DRIVER'), wrap(async (req, res) => {
  const { rows } = await db.query(`SELECT * FROM driver_profiles WHERE user_id=$1`, [req.user.id]);
  const p = rows[0];
  const today = await db.query(
    `SELECT coalesce(sum(driver_earning_kes),0) AS earned, count(*)::int AS trips FROM trips
      WHERE driver_id=$1 AND status='PAID' AND ended_at >= date_trunc('day', now() AT TIME ZONE 'Africa/Nairobi') AT TIME ZONE 'Africa/Nairobi'`, [req.user.id]);
  res.json({
    minPrePhotos: config.trip.minPrePhotos, verificationStatus: p.verification_status, rejectionReason: p.rejection_reason, online: p.online,
    rating: Number(p.rating_avg), tripsCompleted: p.trips_completed, wallet: Number(p.wallet_balance_kes),
    hasDocuments: !!(p.id_url && p.license_url && p.good_conduct_url), today: { earned: Number(today.rows[0].earned), trips: today.rows[0].trips },
  });
}));

// KYC submission. Document images are URLs/data-URLs handled by the same photo store in production.
router.post('/me/documents', requireRole('DRIVER'), wrap(async (req, res) => {
  const b = z.object({
    nationalId: z.string().regex(/^\d{7,9}$/, 'National ID must be 7-9 digits'),
    licenseNumber: z.string().min(5).max(30),
    idUrl: z.string().max(500), licenseUrl: z.string().max(500), goodConductUrl: z.string().max(500),
    vehicleType: z.enum(['E-SCOOTER', 'E-BIKE']).default('E-SCOOTER'),
  }).parse(req.body);
  await db.query(
    `UPDATE driver_profiles SET national_id=$2, license_number=$3, id_url=$4, license_url=$5, good_conduct_url=$6,
            vehicle_type=$7, verification_status='PENDING', rejection_reason=NULL WHERE user_id=$1`,
    [req.user.id, b.nationalId, b.licenseNumber, b.idUrl, b.licenseUrl, b.goodConductUrl, b.vehicleType]);
  res.json({ ok: true, verificationStatus: 'PENDING' });
}));

// KYC document upload (base64 data URL) -> private URL to pass to /me/documents
router.post('/me/upload', requireRole('DRIVER'), wrap(async (req, res) => {
  const { image } = z.object({ image: z.string() }).parse(req.body);
  res.status(201).json({ url: trips.savePhoto(image) });
}));

router.post('/me/online', requireRole('DRIVER'), wrap(async (req, res) => {
  const { online } = z.object({ online: z.boolean() }).parse(req.body);
  const p = (await db.query(`SELECT verification_status FROM driver_profiles WHERE user_id=$1`, [req.user.id])).rows[0];
  if (online && p.verification_status !== 'APPROVED') throw new HttpError(403, 'Your account is not approved yet', 'NOT_APPROVED');
  await db.query(`UPDATE driver_profiles SET online=$2 WHERE user_id=$1`, [req.user.id, online]);
  if (!online) await loc.store.remove(req.user.id);
  res.json({ online });
}));

// HTTP fallback for location pings (the PWA normally uses the socket)
router.post('/me/location', requireRole('DRIVER'), wrap(async (req, res) => {
  const b = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).parse(req.body);
  await loc.onDriverLocation(req.user.id, b.lat, b.lng);
  res.json({ ok: true });
}));

router.get('/me/earnings', requireRole('DRIVER'), wrap(async (req, res) => {
  const trips = await db.query(
    `SELECT id, ended_at, final_fare_kes, driver_earning_kes, commission_kes FROM trips
      WHERE driver_id=$1 AND status='PAID' ORDER BY id DESC LIMIT 50`, [req.user.id]);
  const payouts = await db.query(`SELECT id, amount_kes, status, created_at FROM payouts WHERE driver_id=$1 ORDER BY id DESC LIMIT 20`, [req.user.id]);
  res.json({ trips: trips.rows, payouts: payouts.rows });
}));

router.post('/me/payouts', requireRole('DRIVER'), wrap(async (req, res) => res.status(201).json(await payments.requestPayout(req.user.id))));

// Nearby available drivers (used by the client map and by admins)
router.get('/nearby', wrap(async (req, res) => {
  const q = z.object({
    lat: z.coerce.number().min(-90).max(90), lng: z.coerce.number().min(-180).max(180), radius: z.coerce.number().min(0.5).max(15).default(3),
  }).parse(req.query);
  const near = await loc.store.nearby(q.lat, q.lng, q.radius);
  // Privacy: clients only see anonymous positions, rounded to ~100m
  res.json(near.map((n) => ({ lat: +n.lat.toFixed(3), lng: +n.lng.toFixed(3), distanceKm: +n.distanceKm.toFixed(2) })));
}));

module.exports = router;
