// Pure pricing functions (no I/O) so they are easy to unit test.
const config = require('../config');
const { haversineKm, round2 } = require('../utils');

const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

// Minutes since local midnight in Nairobi for a given Date.
function localMinutes(date, offsetMin = config.pricing.timezoneOffsetMin) {
  const utc = date.getUTCHours() * 60 + date.getUTCMinutes();
  return (utc + offsetMin + 1440) % 1440;
}

// Night window may wrap midnight (23:00 -> 04:00).
function isNightSurge(date = new Date(), p = config.pricing) {
  const now = localMinutes(date, p.timezoneOffsetMin);
  const s = toMin(p.surgeStart);
  const e = toMin(p.surgeEnd);
  return s <= e ? now >= s && now < e : now >= s || now < e;
}

function estimateDistanceKm(a, b, p = config.pricing) {
  return round2(haversineKm(a.lat, a.lng, b.lat, b.lng) * p.roadFactor);
}

function applyPromo(subtotal, promo) {
  if (!promo) return 0;
  const pct = Math.floor((subtotal * (promo.percent_off || 0)) / 100);
  return Math.min(subtotal, pct + (promo.flat_off_kes || 0));
}

/**
 * Fare = max(minFare, base + perKm*km + perMinWait*waitMin) * surge, minus promo.
 * zoneSurge (admin-configured) and night surge combine by taking the larger.
 */
function calculateFare({ distanceKm, waitMinutes = 0, at = new Date(), zoneSurge = 1, promo = null }, p = config.pricing) {
  const raw = p.baseFare + p.perKm * distanceKm + p.perMinWait * waitMinutes;
  const surge = Math.max(zoneSurge, isNightSurge(at, p) ? p.surgeMultiplier : 1);
  const subtotal = Math.round(Math.max(p.minFare, raw) * surge);
  const discount = applyPromo(subtotal, promo);
  return { subtotal, surge, discount, total: subtotal - discount };
}

function splitFare(total, p = config.pricing) {
  const commission = round2((total * p.commissionPct) / 100);
  return { commission, driverEarning: round2(total - commission) };
}

function cancellationFee(acceptedAt, now = new Date(), p = config.pricing) {
  if (!acceptedAt) return 0;
  const elapsed = (now - new Date(acceptedAt)) / 1000;
  return elapsed <= p.cancelGraceSec ? 0 : p.cancelFee;
}

module.exports = { isNightSurge, estimateDistanceKm, calculateFare, splitFare, cancellationFee, applyPromo, localMinutes };
