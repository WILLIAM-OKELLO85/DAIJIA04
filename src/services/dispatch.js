// Dispatch engine: finds nearby available drivers, offers the trip to the best few,
// waits for an accept, and widens the search radius if nobody takes it.
// Offer state lives in memory (single node). For multi-node, move `pending` to Redis.
const db = require('../db');
const config = require('../config');
const rt = require('../realtime');
const store = require('./locationStore');
const { isNightSurge } = require('./pricing');

const pending = new Map(); // tripId -> { batch:Set, declined:Set, wake:fn }
const D = config.dispatch;

async function rankedCandidates(trip, radiusKm, exclude) {
  const near = await store.nearby(Number(trip.pickup_lat), Number(trip.pickup_lng), radiusKm);
  if (!near.length) return [];
  const ids = near.map((n) => Number(n.id)).filter((id) => !exclude.has(id));
  if (!ids.length) return [];
  const { rows } = await db.query(
    `SELECT u.id, u.name, dp.rating_avg, dp.last_trip_end
       FROM users u JOIN driver_profiles dp ON dp.user_id = u.id
      WHERE u.id = ANY($1) AND u.status='ACTIVE' AND dp.online AND dp.verification_status='APPROVED'
        AND NOT EXISTS (SELECT 1 FROM trips t WHERE t.driver_id = u.id
                        AND t.status IN ('ACCEPTED','DRIVER_EN_ROUTE','ARRIVED','IN_PROGRESS'))`, [ids]);
  const byId = new Map(near.map((n) => [Number(n.id), n]));
  const now = Date.now();
  return rows.map((r) => {
    const dist = byId.get(r.id).distanceKm;
    const idleMin = r.last_trip_end ? Math.min(60, (now - new Date(r.last_trip_end)) / 60000) : 60;
    // lower is better: closer, higher rating and longer idle time all help
    const score = dist - 0.5 * (Number(r.rating_avg) - 4) - 0.5 * (idleMin / 60);
    return { id: r.id, distanceKm: dist, score };
  }).sort((a, b) => a.score - b.score);
}

const wait = (tripId, ms) => new Promise((resolve) => {
  const p = pending.get(tripId);
  const t = setTimeout(resolve, ms);
  p.wake = () => { clearTimeout(t); resolve(); };
});

async function loadTrip(tripId) {
  const { rows } = await db.query(`SELECT * FROM trips WHERE id=$1`, [tripId]);
  return rows[0];
}

async function run(tripId) {
  const declined = new Set();
  pending.set(tripId, { batch: new Set(), declined, wake: () => {} });
  try {
    let radius = D.initialRadiusKm * (isNightSurge() ? 1.5 : 1); // FR-M4: wider net at peak
    while (radius <= D.maxRadiusKm * 1.5) {
      let trip = await loadTrip(tripId);
      if (!trip || trip.status !== 'MATCHING') return;

      const cands = await rankedCandidates(trip, radius, declined);
      if (cands.length) {
        const batch = cands.slice(0, D.offersPerRound);
        const p = pending.get(tripId);
        p.batch = new Set(batch.map((c) => c.id));
        for (const c of batch) {
          rt.toUser(c.id, 'trip:offer', {
            tripId, pickup: { lat: Number(trip.pickup_lat), lng: Number(trip.pickup_lng), address: trip.pickup_address },
            dropoff: { address: trip.dropoff_address }, distanceKm: Number(trip.est_distance_km),
            fare: Number(trip.est_fare_kes), driverEarning: Number(trip.est_fare_kes) * (1 - config.pricing.commissionPct / 100),
            pickupDistanceKm: Number(c.distanceKm.toFixed(2)), expiresInSec: D.acceptTimeoutSec,
          });
        }
        await wait(tripId, D.acceptTimeoutSec * 1000);
        trip = await loadTrip(tripId);
        if (!trip || trip.status !== 'MATCHING') return;
        // Offer expired: don't re-offer to those who ignored it this round; widen next loop.
        batch.forEach((c) => { declined.add(c.id); rt.toUser(c.id, 'trip:offer_expired', { tripId }); });
      }
      radius += 2;
      await new Promise((r) => setTimeout(r, 500));
    }
    // Nobody accepted.
    const { rows } = await db.query(
      `UPDATE trips SET status='NO_DRIVER_FOUND', ended_at=now() WHERE id=$1 AND status='MATCHING' RETURNING client_id`, [tripId]);
    if (rows[0]) {
      await db.query(`INSERT INTO trip_events (trip_id,type) VALUES ($1,'NO_DRIVER_FOUND')`, [tripId]);
      rt.toUser(rows[0].client_id, 'trip:update', { tripId, status: 'NO_DRIVER_FOUND' });
    }
  } catch (e) {
    console.error('[dispatch] error for trip', tripId, e);
  } finally {
    pending.delete(tripId);
  }
}

const start = (tripId) => { run(tripId); };
const isOffered = (tripId, driverId) => !!pending.get(tripId)?.batch.has(driverId);
const resolve = (tripId) => pending.get(tripId)?.wake();

function decline(tripId, driverId) {
  const p = pending.get(tripId);
  if (!p) return;
  p.declined.add(driverId);
  p.batch.delete(driverId);
  if (p.batch.size === 0) p.wake(); // everyone in this round said no: escalate immediately
}

async function resumeUnmatched() {
  const { rows } = await db.query(`SELECT id FROM trips WHERE status='MATCHING'`);
  rows.forEach((r) => start(r.id));
}

module.exports = { start, isOffered, resolve, decline, resumeUnmatched };
