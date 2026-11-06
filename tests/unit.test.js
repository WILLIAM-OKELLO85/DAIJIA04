const test = require('node:test');
const assert = require('node:assert/strict');
const pricing = require('../src/services/pricing');
const { canTransition } = require('../src/services/tripMachine');
const { normalizePhone, haversineKm } = require('../src/utils');

// Nairobi is UTC+3: 23:30 EAT = 20:30Z, 12:00 EAT = 09:00Z, 03:59 EAT = 00:59Z, 04:00 EAT = 01:00Z
const at = (iso) => new Date(iso);

test('night surge window wraps midnight', () => {
  assert.equal(pricing.isNightSurge(at('2026-10-23T20:30:00Z')), true);   // 23:30
  assert.equal(pricing.isNightSurge(at('2026-10-23T22:00:00Z')), true);   // 01:00
  assert.equal(pricing.isNightSurge(at('2026-10-24T00:59:00Z')), true);   // 03:59
  assert.equal(pricing.isNightSurge(at('2026-10-24T01:00:00Z')), false);  // 04:00 boundary
  assert.equal(pricing.isNightSurge(at('2026-10-23T09:00:00Z')), false);  // noon
  assert.equal(pricing.isNightSurge(at('2026-10-23T19:59:00Z')), false);  // 22:59
  assert.equal(pricing.isNightSurge(at('2026-10-23T20:00:00Z')), true);   // 23:00 boundary
});

test('fare: minimum applies, surge multiplies, promo discounts', () => {
  const day = at('2026-10-23T09:00:00Z');
  assert.equal(pricing.calculateFare({ distanceKm: 1, at: day }).total, 500);            // 300+40=340 -> min 500
  assert.equal(pricing.calculateFare({ distanceKm: 10, at: day }).total, 700);           // 300+400
  assert.equal(pricing.calculateFare({ distanceKm: 10, at: at('2026-10-23T21:00:00Z') }).total, 1050); // x1.5
  const promo = { percent_off: 20, flat_off_kes: 0 };
  assert.equal(pricing.calculateFare({ distanceKm: 10, at: day, promo }).total, 560);
  assert.equal(pricing.calculateFare({ distanceKm: 10, at: day, promo: { percent_off: 0, flat_off_kes: 5000 } }).total, 0); // never negative
});

test('zone surge and night surge do not stack, larger wins', () => {
  const night = at('2026-10-23T21:00:00Z');
  assert.equal(pricing.calculateFare({ distanceKm: 10, at: night, zoneSurge: 2 }).surge, 2);
  assert.equal(pricing.calculateFare({ distanceKm: 10, at: night, zoneSurge: 1.2 }).surge, 1.5);
});

test('fare split adds up', () => {
  const s = pricing.splitFare(1000);
  assert.equal(s.commission, 200);
  assert.equal(s.driverEarning, 800);
});

test('cancellation fee respects grace period', () => {
  const t0 = new Date('2026-10-23T10:00:00Z');
  assert.equal(pricing.cancellationFee(t0, new Date(t0.getTime() + 60_000)), 0);
  assert.equal(pricing.cancellationFee(t0, new Date(t0.getTime() + 121_000)), 100);
  assert.equal(pricing.cancellationFee(null), 0);
});

test('state machine rejects illegal jumps', () => {
  assert.ok(canTransition('MATCHING', 'ACCEPTED'));
  assert.ok(canTransition('ARRIVED', 'IN_PROGRESS'));
  assert.ok(!canTransition('ACCEPTED', 'IN_PROGRESS'));   // must arrive first
  assert.ok(!canTransition('IN_PROGRESS', 'CANCELLED_BY_CLIENT'));
  assert.ok(!canTransition('PAID', 'COMPLETED'));
  assert.ok(!canTransition('NOPE', 'PAID'));
});

test('phone normalisation', () => {
  for (const p of ['0712345678', '712345678', '254712345678', '+254712345678', '0112345678', '0712 345 678'])
    assert.match(normalizePhone(p), /^\+254[17]\d{8}$/);
  for (const p of ['0212345678', '12345', '', null, '+255712345678']) assert.equal(normalizePhone(p), null);
});

test('haversine: Westlands to Karen is roughly 14 km', () => {
  const d = haversineKm(-1.2673, 36.8113, -1.319, 36.707);
  assert.ok(d > 11 && d < 15, `got ${d}`);
});
