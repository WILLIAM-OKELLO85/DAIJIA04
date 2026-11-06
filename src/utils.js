class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Normalise Kenyan numbers to E.164: 0712345678 / 712345678 / +254712345678 -> +254712345678
function normalizePhone(raw) {
  let p = String(raw || '').replace(/[\s-]/g, '');
  if (/^\+254[17]\d{8}$/.test(p)) return p;
  if (/^254[17]\d{8}$/.test(p)) return '+' + p;
  if (/^0[17]\d{8}$/.test(p)) return '+254' + p.slice(1);
  if (/^[17]\d{8}$/.test(p)) return '+254' + p;
  return null;
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const round2 = (n) => Math.round(n * 100) / 100;

module.exports = { HttpError, wrap, normalizePhone, haversineKm, round2 };
