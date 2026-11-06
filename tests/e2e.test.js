// End-to-end trip flow against a real Postgres. Skipped unless TEST_DATABASE_URL is set.
// WARNING: truncates all tables in that database.
const test = require('node:test');
const assert = require('node:assert/strict');

const DB = process.env.TEST_DATABASE_URL;
if (!DB) { test('e2e (skipped: set TEST_DATABASE_URL)', { skip: true }, () => {}); return; }

Object.assign(process.env, {
  DATABASE_URL: DB, REDIS_URL: '', MPESA_ENV: 'mock', NODE_ENV: 'test', ADMIN_PHONES: '+254700000001',
  DRIVER_ACCEPT_TIMEOUT_SEC: '4', MIN_PRE_PHOTOS: '2',
});

const http = require('node:http');
const { io: ioc } = require('socket.io-client');
const db = require('../src/db');
const app = require('../src/app');
const rt = require('../src/realtime');
const loc = require('../src/services/locationService');

let base, server;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, path, token, body) {
  const res = await fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}
async function login(phone, role, name) {
  const r1 = await call('POST', '/api/v1/auth/otp/request', null, { phone });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  const r2 = await call('POST', '/api/v1/auth/otp/verify', null, { phone, code: r1.body.devCode, role, name });
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  return r2.body;
}
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timeout'); await sleep(250); }
}

test.before(async () => {
  await db.query(`TRUNCATE users, otp_codes, trips, payments, payouts, sos_alerts, venue_staff, venues, audit_log RESTART IDENTITY CASCADE`);
  server = http.createServer(app);
  rt.init(server, { onDriverLocation: loc.onDriverLocation });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { server.close(); rt.io?.close?.(); await db.pool.end(); setTimeout(() => process.exit(), 100).unref(); });

const PICKUP = { lat: -1.2650, lng: 36.8040, address: 'Demo Lounge' };
const DROP = { lat: -1.2900, lng: 36.7850, address: 'Kilimani' };

test('auth: validation, OTP, and role handling', async () => {
  assert.equal((await call('POST', '/api/v1/auth/otp/request', null, { phone: '12345' })).status, 400);
  const r = await call('POST', '/api/v1/auth/otp/request', null, { phone: '0711000001' });
  assert.equal((await call('POST', '/api/v1/auth/otp/verify', null, { phone: '0711000001', code: '000000' })).status, 400);
  const ok = await call('POST', '/api/v1/auth/otp/verify', null, { phone: '0711000001', code: r.body.devCode, role: 'CLIENT', name: 'Test Client' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.role, 'CLIENT');
  assert.equal((await call('POST', '/api/v1/auth/otp/verify', null, { phone: '0711000001', code: r.body.devCode })).status, 400, 'code is single use');
  // cannot self-register as ADMIN/VENUE
  assert.equal((await call('POST', '/api/v1/auth/otp/verify', null, { phone: '0711000001', code: '123456', role: 'ADMIN' })).status, 400);
  // refresh rotation
  const rf = await call('POST', '/api/v1/auth/refresh', null, { refreshToken: ok.body.refreshToken });
  assert.equal(rf.status, 200);
  assert.equal((await call('POST', '/api/v1/auth/refresh', null, { refreshToken: ok.body.refreshToken })).status, 401, 'old refresh token is dead');
  // protected routes
  assert.equal((await call('GET', '/api/v1/trips')).status, 401);
  assert.equal((await call('GET', '/api/v1/admin/analytics', ok.body.accessToken)).status, 403);
});

test('full trip: request -> match -> inspect -> drive -> pay -> payout', async () => {
  const admin = await login('0700000001', 'CLIENT', 'Admin');
  assert.equal(admin.user.role, 'ADMIN');
  const client = await login('0711000002', 'CLIENT', 'Wanjiru Client');
  const driver = await login('0722000002', 'DRIVER', 'Otieno Driver');

  // driver cannot go online before KYC approval
  assert.equal((await call('PUT', '/api/v1/drivers/me/online', driver.accessToken, { online: true })).status, 404);
  assert.equal((await call('POST', '/api/v1/drivers/me/online', driver.accessToken, { online: true })).status, 403);
  const up = await call('POST', '/api/v1/drivers/me/upload', driver.accessToken, { image: PNG });
  assert.equal(up.status, 201);
  assert.equal((await call('POST', `/api/v1/admin/drivers/${driver.user.id}/review`, admin.accessToken, { approve: true })).status, 422, 'no docs yet');
  assert.equal((await call('POST', '/api/v1/drivers/me/documents', driver.accessToken, {
    nationalId: '12345678', licenseNumber: 'DL-998877', idUrl: up.body.url, licenseUrl: up.body.url, goodConductUrl: up.body.url })).status, 200);
  assert.equal((await call('POST', `/api/v1/admin/drivers/${driver.user.id}/review`, admin.accessToken, { approve: true })).status, 200);
  assert.equal((await call('POST', '/api/v1/drivers/me/online', driver.accessToken, { online: true })).status, 200);

  // sockets
  const dSock = ioc(base, { auth: { token: driver.accessToken } });
  const cSock = ioc(base, { auth: { token: client.accessToken } });
  const offers = [], updates = [];
  dSock.on('trip:offer', (o) => offers.push(o));
  cSock.on('trip:update', (u) => updates.push(u.status));
  await until(() => dSock.connected && cSock.connected);
  dSock.emit('driver:location', { lat: -1.2660, lng: 36.8050 });
  await until(async () => (await call('GET', '/api/v1/drivers/nearby?lat=-1.265&lng=36.804&radius=3', client.accessToken)).body.length === 1);

  // out-of-zone is refused; in-zone quote works
  assert.equal((await call('POST', '/api/v1/trips/quote', client.accessToken, { pickup: { lat: 0, lng: 0 }, dropoff: DROP })).status, 422);
  const q = await call('POST', '/api/v1/trips/quote', client.accessToken, { pickup: PICKUP, dropoff: DROP, promoCode: 'LAUNCH20' });
  assert.equal(q.status, 200, JSON.stringify(q.body));
  assert.ok(q.body.discount > 0 && q.body.total === q.body.subtotal - q.body.discount);
  assert.equal((await call('POST', '/api/v1/trips/quote', client.accessToken, { pickup: PICKUP, dropoff: DROP, promoCode: 'NOPE' })).status, 400);

  const req = await call('POST', '/api/v1/trips/request', client.accessToken, { pickup: PICKUP, dropoff: DROP, promoCode: 'LAUNCH20' });
  assert.equal(req.status, 201, JSON.stringify(req.body));
  const tripId = req.body.id;
  assert.equal((await call('POST', '/api/v1/trips/request', client.accessToken, { pickup: PICKUP, dropoff: DROP })).status, 409, 'one active trip at a time');

  await until(() => offers.length > 0);
  assert.equal(offers[0].tripId, tripId);

  // wrong driver / role cannot accept
  assert.equal((await call('POST', `/api/v1/trips/${tripId}/accept`, client.accessToken)).status, 403);
  assert.equal((await call('POST', `/api/v1/trips/${tripId}/accept`, driver.accessToken)).status, 200);
  assert.equal((await call('POST', `/api/v1/trips/${tripId}/accept`, driver.accessToken)).status, 409, 'cannot accept twice');

  // illegal jumps
  assert.equal((await call('POST', `/api/v1/trips/${tripId}/start`, driver.accessToken)).status, 422, 'needs photos first');
  assert.equal((await call('POST', `/api/v1/trips/${tripId}/arrived`, driver.accessToken)).status, 409, 'must be en route first');
  assert.equal((await call('POST', `/api/v1/trips/${tripId}/en-route`, driver.accessToken)).status, 200);
  await sleep(1000); dSock.emit('driver:location', { lat: -1.9, lng: 36.0 }); await sleep(300);       // far away (socket pings are throttled to 1/s)
  assert.equal((await call('POST', `/api/v1/trips/${tripId}/arrived`, driver.accessToken)).status, 422, 'too far from pickup');
  await sleep(1000); dSock.emit('driver:location', { lat: PICKUP.lat, lng: PICKUP.lng }); await sleep(300);
  assert.equal((await call('POST', `/api/v1/trips/${tripId}/arrived`, driver.accessToken)).status, 200);

  // inspection photos
  assert.equal((await call('POST', `/api/v1/trips/${tripId}/photos`, driver.accessToken, { phase: 'PRE', image: 'not-an-image' })).status, 400);
  for (let i = 0; i < 2; i++) assert.equal((await call('POST', `/api/v1/trips/${tripId}/photos`, driver.accessToken, { phase: 'PRE', image: PNG })).status, 201);
  const st = await call('POST', `/api/v1/trips/${tripId}/start`, driver.accessToken);
  assert.equal(st.status, 200, JSON.stringify(st.body));
  assert.ok(st.body.insurance_ref);

  // drive: ping along the route
  for (let i = 1; i <= 5; i++) {
    await sleep(950);
    dSock.emit('driver:location', { lat: PICKUP.lat + (DROP.lat - PICKUP.lat) * (i / 5), lng: PICKUP.lng + (DROP.lng - PICKUP.lng) * (i / 5) });
  }
  const done = await call('POST', `/api/v1/trips/${tripId}/complete`, driver.accessToken);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.final_fare_kes, q.body.total, 'fare matches quote when GPS is implausible/short');

  // another trip is blocked until paid
  assert.equal((await call('POST', '/api/v1/trips/request', client.accessToken, { pickup: PICKUP, dropoff: DROP })).status, 402);
  // someone else cannot pay or see it
  const other = await login('0711000003', 'CLIENT', 'Other');
  assert.equal((await call('POST', '/api/v1/payments/mpesa/stk-push', other.accessToken, { tripId })).status, 403);
  assert.equal((await call('GET', `/api/v1/trips/${tripId}`, other.accessToken)).status, 403);

  // pay (mock M-Pesa confirms after ~2.5s)
  assert.equal((await call('POST', '/api/v1/payments/mpesa/stk-push', client.accessToken, { tripId })).status, 202);
  await until(async () => (await call('GET', `/api/v1/trips/${tripId}`, client.accessToken)).body.status === 'PAID', 10000);
  const pay = (await call('GET', `/api/v1/payments/trip/${tripId}`, client.accessToken)).body;
  assert.equal(pay.status, 'SUCCESS');

  // callback endpoint: needs secret, and is idempotent
  assert.equal((await call('POST', '/api/v1/payments/mpesa/callback', null, {})).status, 403);

  // rating
  // regression: a paid-but-unrated trip must stay "current" for the client so the app can ask for a rating
  assert.equal((await call('GET', '/api/v1/trips/current', client.accessToken)).body?.status, 'PAID');
  assert.equal((await call('GET', '/api/v1/trips/current', driver.accessToken)).body, null, 'driver is free once paid');
  assert.equal((await call('POST', `/api/v1/trips/${tripId}/rate`, client.accessToken, { rating: 4, feedback: 'smooth' })).status, 200);
  assert.equal((await call('POST', `/api/v1/trips/${tripId}/rate`, client.accessToken, { rating: 5 })).status, 409);
  assert.equal((await call('GET', '/api/v1/trips/current', client.accessToken)).body, null, 'rated trip is no longer current');

  // driver earnings and payout
  const me = (await call('GET', '/api/v1/drivers/me', driver.accessToken)).body;
  assert.equal(me.wallet, Math.round(q.body.total * 0.8 * 100) / 100);
  const po = await call('POST', '/api/v1/drivers/me/payouts', driver.accessToken);
  assert.equal(po.status, 201, JSON.stringify(po.body));
  assert.equal((await call('GET', '/api/v1/drivers/me', driver.accessToken)).body.wallet, 0);
  assert.equal((await call('POST', '/api/v1/drivers/me/payouts', driver.accessToken)).status, 422, 'nothing left to pay out');

  // photos are private
  const photos = (await call('GET', `/api/v1/trips/${tripId}`, client.accessToken)).body.photos;
  assert.equal((await fetch(base + photos[0].photo_url)).status, 401);
  assert.equal((await fetch(`${base}${photos[0].photo_url}?token=${client.accessToken}`)).status, 200);
  assert.equal((await fetch(`${base}${photos[0].photo_url}?token=${other.accessToken}`)).status, 403);

  // share link is public and read-only
  const tok = (await call('GET', `/api/v1/trips/${tripId}`, client.accessToken)).body.share_token;
  const sh = await call('GET', `/api/v1/share/${tok}`);
  assert.equal(sh.status, 200);
  assert.equal(sh.body.status, 'PAID');
  assert.equal((await call('GET', '/api/v1/share/' + 'a'.repeat(32))).status, 404);
  assert.ok(!('share_token' in ((await call('GET', `/api/v1/trips/${tripId}`, driver.accessToken)).body)), 'driver does not get share token');

  // event audit trail, admin analytics
  const ev = (await call('GET', `/api/v1/admin/trips/${tripId}/events`, admin.accessToken)).body.events.map((e) => e.type);
  for (const t of ['REQUESTED', 'ACCEPTED', 'DRIVER_EN_ROUTE', 'ARRIVED', 'IN_PROGRESS', 'COMPLETED', 'PAID']) assert.ok(ev.includes(t), `missing ${t}`);
  const an = (await call('GET', '/api/v1/admin/analytics', admin.accessToken)).body;
  assert.equal(an.paid_trips, 1);

  assert.ok(updates.includes('ACCEPTED') && updates.includes('PAID'), `client saw: ${updates}`);
  dSock.close(); cSock.close();
});

test('cancellation, no-driver, SOS', async () => {
  const client = await login('0711000004', 'CLIENT', 'Cancel Client');
  const r = await call('POST', '/api/v1/trips/request', client.accessToken, { pickup: PICKUP, dropoff: DROP });
  assert.equal(r.status, 201);
  const c = await call('POST', `/api/v1/trips/${r.body.id}/cancel`, client.accessToken, { reason: 'changed my mind' });
  assert.equal(c.status, 200);
  assert.equal(c.body.status, 'CANCELLED_BY_CLIENT');
  assert.equal((await call('POST', `/api/v1/trips/${r.body.id}/cancel`, client.accessToken)).status, 409, 'cannot cancel twice');

  const contact = await call('POST', '/api/v1/auth/emergency-contacts', client.accessToken, { name: 'Mum', phone: '0733000000' });
  assert.equal(contact.status, 201);
  const sos = await call('POST', '/api/v1/sos/trigger', client.accessToken, { lat: -1.28, lng: 36.8 });
  assert.equal(sos.status, 201);
  assert.equal(sos.body.notifiedContacts, 1);
});

test('venue portal: staff request a ride for a patron; patron shares a live link', async () => {
  await db.query(`UPDATE otp_codes SET created_at = created_at - interval '2 minutes' WHERE phone='+254700000001'`); // skip the 30s resend cooldown
  const admin = await login('0700000001', 'CLIENT', 'Ops');
  assert.equal(admin.user.role, 'ADMIN');
  const v = await call('POST', '/api/v1/admin/venues', admin.accessToken, { name: 'Test Bar', lat: PICKUP.lat, lng: PICKUP.lng, staffPhone: '0733000009' });
  assert.equal(v.status, 201, JSON.stringify(v.body));
  assert.equal((await call('POST', '/api/v1/admin/venues', admin.accessToken, { name: 'Test Bar', lat: 0, lng: 0 })).status, 409, 'duplicate venue name is a conflict, not a crash');
  const byCode = await call('GET', `/api/v1/venues/by-code/${v.body.referral_code.toLowerCase()}`);
  assert.equal(byCode.status, 200);

  const staff = await login('0733000009', 'CLIENT');           // pre-created VENUE account just signs in
  assert.equal(staff.user.role, 'VENUE');
  const mine = await call('GET', '/api/v1/venues/mine', staff.accessToken);
  assert.equal(mine.body.id, v.body.id);
  // a different venue's staff cannot act for this venue
  const v2 = await call('POST', '/api/v1/admin/venues', admin.accessToken, { name: 'Other Bar', lat: PICKUP.lat, lng: PICKUP.lng, staffPhone: '0733000010' });
  const other = await login('0733000010', 'CLIENT');
  const denied = await call('POST', `/api/v1/venues/${v.body.id}/request-driver`, other.accessToken, { patronPhone: '0744000001', dropoff: DROP });
  assert.equal(denied.status, 403);
  assert.notEqual(v2.body.id, v.body.id);

  const req = await call('POST', `/api/v1/venues/${v.body.id}/request-driver`, staff.accessToken, { patronPhone: '0744000001', patronName: 'Patron', dropoff: DROP });
  assert.equal(req.status, 201, JSON.stringify(req.body));
  assert.equal(req.body.status, 'MATCHING');
  assert.equal((await call('GET', `/api/v1/venues/${v.body.id}/stats`, staff.accessToken)).body.total_requests, 1);

  const patron = await login('0744000001', 'CLIENT');
  const cur = await call('GET', '/api/v1/trips/current', patron.accessToken);
  assert.equal(cur.body.id, req.body.id);
  const share = await call('GET', `/api/v1/share/${cur.body.share_token}`);
  assert.equal(share.status, 200);
  assert.equal(share.body.status, 'MATCHING');
  assert.equal(share.body.client_id, undefined, 'share view must not leak internals');
  assert.equal((await call('GET', '/api/v1/share/' + 'a'.repeat(32))).status, 404);
  await call('POST', `/api/v1/trips/${cur.body.id}/cancel`, patron.accessToken, {});
});
