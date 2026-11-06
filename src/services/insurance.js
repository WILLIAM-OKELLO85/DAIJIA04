// Per-trip liability cover. Replace the body of bindCover() with the partner
// insurer's API call (APA / Jubilee / Britam) when the commercial deal is signed.
const crypto = require('crypto');

async function bindCover({ tripId, driverId, clientId }) {
  const ref = `POL-${tripId}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  return { reference: ref, insurer: 'MOCK-INSURER', boundAt: new Date().toISOString() };
}

module.exports = { bindCover };
