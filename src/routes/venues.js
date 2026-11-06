const router = require('express').Router();
const { z } = require('zod');
const db = require('../db');
const trips = require('../services/tripService');
const { authenticate, requireRole } = require('../middleware/auth');
const { HttpError, wrap, normalizePhone } = require('../utils');
const { sendSms } = require('../services/sms');

// Public: resolves a venue QR code (referral code) to the venue's location.
router.get('/by-code/:code', wrap(async (req, res) => {
  const { rows } = await db.query(`SELECT id, name, lat, lng FROM venues WHERE referral_code=upper($1)`, [req.params.code]);
  if (!rows[0]) throw new HttpError(404, 'Unknown venue code', 'NOT_FOUND');
  res.json(rows[0]);
}));

router.use(authenticate, requireRole('VENUE', 'ADMIN'));

async function staffVenue(user, venueId) {
  if (user.role === 'ADMIN') return venueId;
  const { rows } = await db.query(`SELECT venue_id FROM venue_staff WHERE user_id=$1`, [user.id]);
  if (!rows[0] || rows[0].venue_id !== venueId) throw new HttpError(403, 'Not staff at this venue', 'FORBIDDEN');
  return venueId;
}

// The venue the signed-in staff member works at.
router.get('/mine', wrap(async (req, res) => {
  const { rows } = await db.query(
    `SELECT v.id, v.name, v.lat, v.lng, v.referral_code FROM venue_staff s JOIN venues v ON v.id=s.venue_id WHERE s.user_id=$1`, [req.user.id]);
  if (!rows[0]) throw new HttpError(404, 'You are not linked to a venue yet', 'NO_VENUE');
  res.json(rows[0]);
}));

// Staff request a driver on behalf of a patron (who then pays via M-Pesa on their own phone).
router.post('/:id/request-driver', wrap(async (req, res) => {
  const venueId = await staffVenue(req.user, Number(req.params.id));
  const b = z.object({
    patronPhone: z.string(), patronName: z.string().max(80).optional(),
    dropoff: z.object({ lat: z.number(), lng: z.number(), address: z.string().max(200).optional() }),
  }).parse(req.body);
  const phone = normalizePhone(b.patronPhone);
  if (!phone) throw new HttpError(400, 'Invalid patron phone', 'BAD_PHONE');
  const v = (await db.query(`SELECT * FROM venues WHERE id=$1`, [venueId])).rows[0];
  if (!v) throw new HttpError(404, 'Venue not found', 'NOT_FOUND');

  let u = (await db.query(`SELECT * FROM users WHERE phone=$1`, [phone])).rows[0];
  if (!u) u = (await db.query(`INSERT INTO users (phone, name, role) VALUES ($1,$2,'CLIENT') RETURNING *`, [phone, b.patronName ?? null])).rows[0];
  if (u.role !== 'CLIENT') throw new HttpError(422, 'That number belongs to a non-client account', 'BAD_ROLE');

  const trip = await trips.createTrip(u.id, {
    pickup: { lat: Number(v.lat), lng: Number(v.lng), address: v.name }, dropoff: b.dropoff, venueId,
  });
  // The patron pays on their own phone, so tell them where to track and pay.
  sendSms(phone, `SafeRide: a driver has been requested for you at ${v.name}. Track and pay at ${req.protocol}://${req.get('host')}/client/`).catch(() => {});
  res.status(201).json(trip);
}));

router.get('/:id/stats', wrap(async (req, res) => {
  const venueId = await staffVenue(req.user, Number(req.params.id));
  const { rows } = await db.query(
    `SELECT count(*) FILTER (WHERE status='PAID')::int AS paid_trips, count(*)::int AS total_requests
       FROM trips WHERE venue_id=$1`, [venueId]);
  const v = (await db.query(`SELECT referral_bonus_kes, referral_code FROM venues WHERE id=$1`, [venueId])).rows[0];
  res.json({ ...rows[0], referralCode: v.referral_code, earnedKes: rows[0].paid_trips * Number(v.referral_bonus_kes) });
}));

module.exports = router;
