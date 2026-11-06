const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const config = require('../config');
const rt = require('../realtime');
const dispatch = require('./dispatch');
const loc = require('./locationService');
const insurance = require('./insurance');
const { sendSms } = require('./sms');
const { calculateFare, estimateDistanceKm, splitFare, cancellationFee } = require('./pricing');
const { canTransition, DRIVER_BUSY_STATES, ACTIVE_STATES } = require('./tripMachine');
const { HttpError, haversineKm, round2 } = require('../utils');

const FREE_WAIT_MIN = 5;
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');

// ---------- helpers ----------
async function getTrip(id, client = db) {
  const { rows } = await client.query(`SELECT * FROM trips WHERE id=$1`, [id]);
  if (!rows[0]) throw new HttpError(404, 'Trip not found', 'NOT_FOUND');
  return rows[0];
}

const COLS = new Set(['driver_id', 'accepted_at', 'started_at', 'ended_at', 'cancel_reason', 'cancel_fee_kes',
  'actual_distance_km', 'wait_minutes', 'final_fare_kes', 'commission_kes', 'driver_earning_kes', 'insurance_ref']);

// Locks the row, validates the transition, applies column changes, writes an audit event.
async function transition(tripId, to, { actorId, set = {}, payload = {}, expectDriver } = {}) {
  return db.tx(async (c) => {
    const { rows } = await c.query(`SELECT * FROM trips WHERE id=$1 FOR UPDATE`, [tripId]);
    const trip = rows[0];
    if (!trip) throw new HttpError(404, 'Trip not found', 'NOT_FOUND');
    if (expectDriver !== undefined && trip.driver_id !== expectDriver) throw new HttpError(403, 'Not your trip', 'FORBIDDEN');
    if (!canTransition(trip.status, to)) throw new HttpError(409, `Cannot go from ${trip.status} to ${to}`, 'BAD_TRANSITION');
    const keys = Object.keys(set).filter((k) => COLS.has(k));
    const sets = ['status=$2', ...keys.map((k, i) => `${k}=$${i + 3}`)];
    const upd = await c.query(`UPDATE trips SET ${sets.join(',')} WHERE id=$1 RETURNING *`, [tripId, to, ...keys.map((k) => set[k])]);
    await c.query(`INSERT INTO trip_events (trip_id,type,actor_id,payload) VALUES ($1,$2,$3,$4)`, [tripId, to, actorId ?? null, payload]);
    return upd.rows[0];
  });
}

async function publicDriver(driverId) {
  const { rows } = await db.query(
    `SELECT u.id, u.name, dp.rating_avg, dp.trips_completed, dp.vehicle_type, dp.verification_status
       FROM users u JOIN driver_profiles dp ON dp.user_id=u.id WHERE u.id=$1`, [driverId]);
  const r = rows[0];
  return r && { id: r.id, name: r.name, rating: Number(r.rating_avg), trips: r.trips_completed, vehicle: r.vehicle_type, verified: r.verification_status === 'APPROVED' };
}

async function present(trip, viewerRole) {
  const out = { ...trip };
  for (const k of ['est_distance_km', 'est_fare_kes', 'surge_multiplier', 'discount_kes', 'final_fare_kes', 'actual_distance_km']) {
    if (out[k] !== null && out[k] !== undefined) out[k] = Number(out[k]);
  }
  if (viewerRole !== 'CLIENT' && viewerRole !== 'ADMIN') delete out.share_token;
  if (out.driver_id) out.driver = await publicDriver(out.driver_id);
  if (viewerRole === 'DRIVER') {
    const { rows } = await db.query(`SELECT split_part(coalesce(name,'Client'),' ',1) AS first FROM users WHERE id=$1`, [trip.client_id]);
    out.client_first_name = rows[0]?.first;
    out.driver_earning_est = round2(Number(trip.est_fare_kes) * (1 - config.pricing.commissionPct / 100));
  }
  return out;
}

async function push(trip) {
  const status = trip.status;
  rt.toUser(trip.client_id, 'trip:update', { tripId: trip.id, status, trip: await present(trip, 'CLIENT') });
  if (trip.driver_id) rt.toUser(trip.driver_id, 'trip:update', { tripId: trip.id, status, trip: await present(trip, 'DRIVER') });
  rt.toAdmins('trip:update', { tripId: trip.id, status });
}

// ---------- quote & request ----------
async function inServiceZone(lat, lng) {
  const { rows } = await db.query(`SELECT * FROM service_zones WHERE active`);
  if (!rows.length) return { ok: true, surge: 1 };
  let best = null;
  for (const z of rows) {
    if (haversineKm(lat, lng, z.center_lat, z.center_lng) <= z.radius_km) {
      best = Math.max(best ?? 1, Number(z.surge_multiplier));
    }
  }
  return best === null ? { ok: false, surge: 1 } : { ok: true, surge: best };
}

async function findPromo(code) {
  if (!code) return null;
  const { rows } = await db.query(
    `SELECT * FROM promo_codes WHERE code=upper($1) AND active
       AND (expires_at IS NULL OR expires_at > now()) AND (max_uses IS NULL OR used_count < max_uses)`, [code]);
  if (!rows[0]) throw new HttpError(400, 'Promo code is invalid or expired', 'BAD_PROMO');
  return rows[0];
}

async function quote({ pickup, dropoff, promoCode }) {
  const zone = await inServiceZone(pickup.lat, pickup.lng);
  if (!zone.ok) throw new HttpError(422, 'Pickup is outside our current service areas', 'OUT_OF_ZONE');
  const distanceKm = estimateDistanceKm(pickup, dropoff);
  const promo = await findPromo(promoCode);
  const fare = calculateFare({ distanceKm, zoneSurge: zone.surge, promo });
  const near = await loc.store.nearby(pickup.lat, pickup.lng, config.dispatch.maxRadiusKm);
  return { distanceKm, ...fare, nearbyDrivers: near.length, etaMin: near.length ? Math.max(3, Math.round(near[0].distanceKm * 4 + 2)) : null };
}

async function createTrip(clientId, { pickup, dropoff, promoCode, venueId = null }) {
  const active = await db.query(
    `SELECT id FROM trips WHERE client_id=$1 AND status = ANY($2)`, [clientId, ACTIVE_STATES]);
  if (active.rows[0]) throw new HttpError(409, 'You already have an active trip', 'ACTIVE_TRIP');
  const unpaid = await db.query(`SELECT id FROM trips WHERE client_id=$1 AND status IN ('COMPLETED','PAYMENT_FAILED') LIMIT 1`, [clientId]);
  if (unpaid.rows[0]) throw new HttpError(402, 'Please settle your previous trip first', 'UNPAID_TRIP');

  const q = await quote({ pickup, dropoff, promoCode });
  const shareToken = crypto.randomBytes(16).toString('hex');
  const { rows } = await db.query(
    `INSERT INTO trips (client_id, venue_id, status, pickup_lat, pickup_lng, pickup_address, dropoff_lat, dropoff_lng, dropoff_address,
        est_distance_km, est_fare_kes, surge_multiplier, promo_code, discount_kes, share_token)
     VALUES ($1,$2,'MATCHING',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [clientId, venueId, pickup.lat, pickup.lng, pickup.address ?? null, dropoff.lat, dropoff.lng, dropoff.address ?? null,
      q.distanceKm, q.total, q.surge, promoCode ? promoCode.toUpperCase() : null, q.discount, shareToken]);
  const trip = rows[0];
  await db.query(`INSERT INTO trip_events (trip_id,type,actor_id) VALUES ($1,'REQUESTED',$2)`, [trip.id, clientId]);
  rt.toAdmins('trip:update', { tripId: trip.id, status: 'MATCHING' });
  dispatch.start(trip.id);
  return present(trip, 'CLIENT');
}

// ---------- driver actions ----------
async function accept(driverId, tripId) {
  if (!dispatch.isOffered(tripId, driverId)) throw new HttpError(409, 'This offer is no longer available', 'OFFER_GONE');
  const busy = await db.query(`SELECT 1 FROM trips WHERE driver_id=$1 AND status = ANY($2) LIMIT 1`, [driverId, DRIVER_BUSY_STATES]);
  if (busy.rows[0]) throw new HttpError(409, 'Finish your current trip first', 'DRIVER_BUSY');
  const trip = await transition(tripId, 'ACCEPTED', {
    actorId: driverId, set: { driver_id: driverId, accepted_at: new Date() }, payload: { driverId },
  });
  dispatch.resolve(tripId);
  loc.trackTrip(driverId, tripId, trip.client_id, 'ACCEPTED');
  await push(trip);
  return present(trip, 'DRIVER');
}

function declineOffer(driverId, tripId) { dispatch.decline(tripId, driverId); }

async function enRoute(driverId, tripId) {
  const trip = await transition(tripId, 'DRIVER_EN_ROUTE', { actorId: driverId, expectDriver: driverId });
  loc.trackTrip(driverId, tripId, trip.client_id, 'DRIVER_EN_ROUTE');
  await push(trip);
  return present(trip, 'DRIVER');
}

async function arrived(driverId, tripId) {
  const cur = await getTrip(tripId);
  const last = await loc.store.get(driverId);
  if (!last) throw new HttpError(422, 'No recent GPS fix; enable location and try again', 'NO_GPS');
  if (haversineKm(last.lat, last.lng, Number(cur.pickup_lat), Number(cur.pickup_lng)) > 0.5) {
    throw new HttpError(422, 'You are not near the pickup point yet', 'TOO_FAR');
  }
  const trip = await transition(tripId, 'ARRIVED', { actorId: driverId, expectDriver: driverId });
  loc.trackTrip(driverId, tripId, trip.client_id, 'ARRIVED');
  await push(trip);
  return present(trip, 'DRIVER');
}

function savePhoto(dataUrl) {
  const m = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  if (!m) throw new HttpError(400, 'Photo must be a base64 PNG/JPEG/WEBP data URL', 'BAD_PHOTO');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 6 * 1024 * 1024) throw new HttpError(413, 'Photo too large (max 6MB)', 'PHOTO_TOO_LARGE');
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const name = `${crypto.randomBytes(12).toString('hex')}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf, { mode: 0o640 });
  return `/uploads/${name}`;
}

async function addPhoto(driverId, tripId, { phase, image }) {
  const trip = await getTrip(tripId);
  if (trip.driver_id !== driverId) throw new HttpError(403, 'Not your trip', 'FORBIDDEN');
  const okStates = phase === 'PRE' ? ['ARRIVED'] : ['IN_PROGRESS', 'COMPLETED'];
  if (!okStates.includes(trip.status)) throw new HttpError(409, `${phase} photos cannot be added while trip is ${trip.status}`, 'BAD_STATE');
  const url = savePhoto(image);
  const last = await loc.store.get(driverId);
  const { rows } = await db.query(
    `INSERT INTO trip_photos (trip_id, phase, photo_url, lat, lng) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [tripId, phase, url, last?.lat ?? null, last?.lng ?? null]);
  rt.toUser(trip.client_id, 'trip:photo', { tripId, phase, url });
  return rows[0];
}

async function start(driverId, tripId) {
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM trip_photos WHERE trip_id=$1 AND phase='PRE'`, [tripId]);
  if (rows[0].n < config.trip.minPrePhotos) {
    throw new HttpError(422, `Upload at least ${config.trip.minPrePhotos} pre-trip photos of the car first`, 'PHOTOS_REQUIRED');
  }
  const cur = await getTrip(tripId);
  const cover = await insurance.bindCover({ tripId, driverId, clientId: cur.client_id });
  const trip = await transition(tripId, 'IN_PROGRESS', {
    actorId: driverId, expectDriver: driverId, set: { started_at: new Date(), insurance_ref: cover.reference }, payload: cover,
  });
  loc.trackTrip(driverId, tripId, trip.client_id, 'IN_PROGRESS');
  await push(trip);
  return present(trip, 'DRIVER');
}

async function complete(driverId, tripId) {
  const cur = await getTrip(tripId);
  const arrivedEv = await db.query(`SELECT created_at FROM trip_events WHERE trip_id=$1 AND type='ARRIVED' ORDER BY id LIMIT 1`, [tripId]);
  const waitMin = arrivedEv.rows[0] && cur.started_at
    ? Math.max(0, (new Date(cur.started_at) - new Date(arrivedEv.rows[0].created_at)) / 60000 - FREE_WAIT_MIN) : 0;

  const tracked = loc.takeDistanceKm(tripId);
  const est = Number(cur.est_distance_km);
  // GPS distance is only trusted when it is plausibly close to the route estimate.
  const distanceKm = round2(tracked > est * 0.6 && tracked < est * 2.5 ? tracked : est);

  const promo = cur.promo_code ? (await db.query(`SELECT * FROM promo_codes WHERE code=$1`, [cur.promo_code])).rows[0] : null;
  const fare = calculateFare({ distanceKm, waitMinutes: waitMin, at: new Date(cur.requested_at), zoneSurge: Number(cur.surge_multiplier), promo });
  const { commission, driverEarning } = splitFare(fare.total);

  const trip = await transition(tripId, 'COMPLETED', {
    actorId: driverId, expectDriver: driverId,
    set: { ended_at: new Date(), actual_distance_km: distanceKm, wait_minutes: round2(waitMin), final_fare_kes: fare.total, commission_kes: commission, driver_earning_kes: driverEarning },
    payload: { distanceKm, waitMin: round2(waitMin), fare },
  });
  loc.untrackTrip(driverId, tripId);
  await db.query(`UPDATE driver_profiles SET last_trip_end=now() WHERE user_id=$1`, [driverId]);
  await push(trip);
  return present(trip, 'DRIVER');
}

// ---------- cancellation ----------
async function cancel(user, tripId, reason) {
  const cur = await getTrip(tripId);
  const byClient = user.role !== 'DRIVER';
  if (byClient && user.role !== 'ADMIN' && cur.client_id !== user.id) throw new HttpError(403, 'Not your trip', 'FORBIDDEN');
  if (!byClient && cur.driver_id !== user.id) throw new HttpError(403, 'Not your trip', 'FORBIDDEN');

  const fee = byClient && cur.driver_id ? cancellationFee(cur.accepted_at) : 0;
  const trip = await transition(tripId, byClient ? 'CANCELLED_BY_CLIENT' : 'CANCELLED_BY_DRIVER', {
    actorId: user.id, set: { cancel_reason: reason ?? null, cancel_fee_kes: fee, ended_at: new Date() }, payload: { reason, fee },
  });
  dispatch.resolve(tripId);
  if (cur.driver_id) loc.untrackTrip(cur.driver_id, tripId);
  await push(trip);
  if (fee > 0) await sendSms((await db.query(`SELECT phone FROM users WHERE id=$1`, [trip.client_id])).rows[0].phone,
    `SafeRide: a cancellation fee of KES ${fee} applies because the driver was already on the way.`);
  return present(trip, user.role);
}

// ---------- rating ----------
async function rate(clientId, tripId, { rating, feedback }) {
  const trip = await getTrip(tripId);
  if (trip.client_id !== clientId) throw new HttpError(403, 'Not your trip', 'FORBIDDEN');
  if (!['PAID', 'COMPLETED'].includes(trip.status)) throw new HttpError(409, 'Trip not finished yet', 'BAD_STATE');
  if (trip.client_rating) throw new HttpError(409, 'Already rated', 'ALREADY_RATED');
  await db.tx(async (c) => {
    await c.query(`UPDATE trips SET client_rating=$2, client_feedback=$3 WHERE id=$1`, [tripId, rating, feedback ?? null]);
    await c.query(
      `UPDATE driver_profiles SET rating_avg = round(((rating_avg*rating_count)+$2)::numeric/(rating_count+1), 2),
              rating_count = rating_count+1 WHERE user_id=$1`, [trip.driver_id, rating]);
  });
}

// ---------- reads ----------
async function listForUser(user, limit = 30) {
  const col = user.role === 'DRIVER' ? 'driver_id' : 'client_id';
  const { rows } = await db.query(`SELECT * FROM trips WHERE ${col}=$1 ORDER BY id DESC LIMIT $2`, [user.id, limit]);
  return Promise.all(rows.map((r) => present(r, user.role)));
}

async function getForUser(user, tripId) {
  const t = await getTrip(tripId);
  if (user.role !== 'ADMIN' && t.client_id !== user.id && t.driver_id !== user.id) throw new HttpError(403, 'Not your trip', 'FORBIDDEN');
  const out = await present(t, user.role);
  out.photos = (await db.query(`SELECT phase, photo_url, taken_at FROM trip_photos WHERE trip_id=$1 ORDER BY id`, [tripId])).rows;
  return out;
}

async function currentForUser(user) {
  const col = user.role === 'DRIVER' ? 'driver_id' : 'client_id';
  const states = user.role === 'DRIVER' ? [...DRIVER_BUSY_STATES, 'COMPLETED', 'PAYMENT_FAILED'] : [...ACTIVE_STATES, 'COMPLETED', 'PAYMENT_FAILED'];
  // A client's freshly paid trip stays "current" until rated (or a day passes) so the app can ask for a rating.
  const unrated = user.role === 'DRIVER' ? '' : `OR (status='PAID' AND client_rating IS NULL AND ended_at > now() - interval '1 day')`;
  const { rows } = await db.query(`SELECT * FROM trips WHERE ${col}=$1 AND (status = ANY($2) ${unrated}) ORDER BY id DESC LIMIT 1`, [user.id, states]);
  return rows[0] ? getForUser(user, rows[0].id) : null;
}

async function shareView(token) {
  const { rows } = await db.query(`SELECT * FROM trips WHERE share_token=$1`, [token]);
  const t = rows[0];
  if (!t) throw new HttpError(404, 'Link not found', 'NOT_FOUND');
  const drv = t.driver_id ? await loc.store.get(t.driver_id) : null;
  const driver = t.driver_id ? await publicDriver(t.driver_id) : null;
  return {
    status: t.status, pickup: { lat: Number(t.pickup_lat), lng: Number(t.pickup_lng), address: t.pickup_address },
    dropoff: { lat: Number(t.dropoff_lat), lng: Number(t.dropoff_lng), address: t.dropoff_address },
    driver: driver && { name: driver.name, rating: driver.rating }, driverLocation: drv, insurance: t.insurance_ref,
  };
}

module.exports = {
  quote, createTrip, accept, declineOffer, enRoute, arrived, addPhoto, start, complete, cancel, rate,
  savePhoto, listForUser, getForUser, currentForUser, shareView, getTrip, present, push, transition,
};
