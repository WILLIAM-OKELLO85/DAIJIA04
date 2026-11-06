// Receives driver GPS pings, stores them, and fans out to the client on an active trip.
const store = require('./locationStore');
const db = require('../db');
const rt = require('../realtime');
const { haversineKm } = require('../utils');

const activeTrips = new Map();   // driverId -> { tripId, clientId, status }
const distance = new Map();      // tripId -> { km, last:{lat,lng}, lastLogged }

function trackTrip(driverId, tripId, clientId, status) { activeTrips.set(String(driverId), { tripId, clientId, status }); }
function untrackTrip(driverId, tripId) {
  activeTrips.delete(String(driverId));
  if (tripId) distance.delete(String(tripId));
}
function takeDistanceKm(tripId) {
  const d = distance.get(String(tripId));
  distance.delete(String(tripId));
  return d ? d.km : 0;
}

async function onDriverLocation(driverId, lat, lng) {
  await store.set(driverId, lat, lng);
  const t = activeTrips.get(String(driverId));
  if (!t) return;
  rt.toUser(t.clientId, 'driver:location', { tripId: t.tripId, lat, lng, at: Date.now() });
  rt.toAdmins('driver:location', { driverId, tripId: t.tripId, lat, lng });

  if (t.status === 'IN_PROGRESS') {
    const key = String(t.tripId);
    const d = distance.get(key) || { km: 0, last: null, lastLogged: 0 };
    if (d.last) {
      const step = haversineKm(d.last.lat, d.last.lng, lat, lng);
      if (step < 1) d.km += step; // ignore GPS jumps > 1km between pings
    }
    d.last = { lat, lng };
    if (Date.now() - d.lastLogged > 15000) {
      d.lastLogged = Date.now();
      db.query(`INSERT INTO trip_events (trip_id, type, actor_id, payload) VALUES ($1,'LOCATION',$2,$3)`,
        [t.tripId, driverId, { lat, lng, km: Number(d.km.toFixed(3)) }]).catch(() => {});
    }
    distance.set(key, d);
  }
}

async function rehydrate() {
  const { rows } = await db.query(
    `SELECT id, driver_id, client_id, status FROM trips
     WHERE driver_id IS NOT NULL AND status IN ('ACCEPTED','DRIVER_EN_ROUTE','ARRIVED','IN_PROGRESS')`);
  for (const r of rows) trackTrip(r.driver_id, r.id, r.client_id, r.status);
}

module.exports = { onDriverLocation, trackTrip, untrackTrip, takeDistanceKm, rehydrate, store };
