const config = require('../config');

// Africa's Talking SMS. Falls back to console logging when not configured.
async function sendSms(to, message) {
  const { username, apiKey, senderId } = config.sms;
  if (!username || !apiKey) {
    console.log(`[sms:dev] -> ${to}: ${message}`);
    return { simulated: true };
  }
  const base = username === 'sandbox' ? 'https://api.sandbox.africastalking.com' : 'https://api.africastalking.com';
  const body = new URLSearchParams({ username, to, message });
  if (senderId) body.set('from', senderId);
  const res = await fetch(`${base}/version1/messaging`, {
    method: 'POST',
    headers: { apiKey, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    console.error('[sms] failed', res.status, await res.text());
    return { ok: false };
  }
  return { ok: true };
}

module.exports = { sendSms };
