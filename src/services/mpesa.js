// Safaricom Daraja integration: STK Push (client pays) + B2C (driver payouts).
// MPESA_ENV=mock simulates the whole flow with no network calls.
const crypto = require('crypto');
const config = require('../config');

const m = config.mpesa;
const BASE = m.env === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';

let tokenCache = { token: null, exp: 0 };

async function accessToken() {
  if (tokenCache.token && Date.now() < tokenCache.exp) return tokenCache.token;
  const basic = Buffer.from(`${m.consumerKey}:${m.consumerSecret}`).toString('base64');
  const res = await fetch(`${BASE}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${basic}` },
  });
  if (!res.ok) throw new Error(`Daraja auth failed: ${res.status}`);
  const j = await res.json();
  tokenCache = { token: j.access_token, exp: Date.now() + (Number(j.expires_in) - 60) * 1000 };
  return tokenCache.token;
}

const timestamp = () => new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);

// Daraja wants 2547XXXXXXXX (no plus sign)
const msisdn = (phone) => phone.replace('+', '');

async function stkPush({ phone, amount, tripId }) {
  if (m.env === 'mock') {
    return { checkoutRequestId: `ws_CO_mock_${crypto.randomBytes(6).toString('hex')}`, merchantRequestId: `mock-${tripId}`, mock: true };
  }
  const ts = timestamp();
  const password = Buffer.from(`${m.shortcode}${m.passkey}${ts}`).toString('base64');
  const res = await fetch(`${BASE}/mpesa/stkpush/v1/processrequest`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      BusinessShortCode: m.shortcode,
      Password: password,
      Timestamp: ts,
      TransactionType: 'CustomerPayBillOnline',
      Amount: Math.ceil(amount),
      PartyA: msisdn(phone),
      PartyB: m.shortcode,
      PhoneNumber: msisdn(phone),
      CallBackURL: `${m.callbackUrl}?secret=${encodeURIComponent(m.callbackSecret)}`,
      AccountReference: `TRIP${tripId}`,
      TransactionDesc: `SafeRide trip ${tripId}`,
    }),
  });
  const j = await res.json();
  if (!res.ok || j.ResponseCode !== '0') throw new Error(`STK push failed: ${j.errorMessage || j.ResponseDescription || res.status}`);
  return { checkoutRequestId: j.CheckoutRequestID, merchantRequestId: j.MerchantRequestID };
}

// Parse Daraja's callback body into a flat object.
function parseCallback(body) {
  const cb = body?.Body?.stkCallback;
  if (!cb) return null;
  const items = cb.CallbackMetadata?.Item || [];
  const get = (n) => items.find((i) => i.Name === n)?.Value;
  return {
    checkoutRequestId: cb.CheckoutRequestID,
    merchantRequestId: cb.MerchantRequestID,
    success: cb.ResultCode === 0,
    resultCode: cb.ResultCode,
    resultDesc: cb.ResultDesc,
    receipt: get('MpesaReceiptNumber'),
    amount: get('Amount'),
  };
}

async function b2cPayout({ phone, amount, reference }) {
  if (m.env === 'mock') return { ok: true, reference: `mock-b2c-${reference}` };
  const res = await fetch(`${BASE}/mpesa/b2c/v1/paymentrequest`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      InitiatorName: m.b2cInitiator,
      SecurityCredential: m.b2cCredential,
      CommandID: 'BusinessPayment',
      Amount: Math.floor(amount),
      PartyA: m.shortcode,
      PartyB: msisdn(phone),
      Remarks: 'SafeRide driver payout',
      QueueTimeOutURL: `${m.callbackUrl.replace('/mpesa/callback', '/mpesa/b2c-timeout')}?secret=${encodeURIComponent(m.callbackSecret)}`,
      ResultURL: `${m.callbackUrl.replace('/mpesa/callback', '/mpesa/b2c-result')}?secret=${encodeURIComponent(m.callbackSecret)}`,
      Occasion: reference,
    }),
  });
  const j = await res.json();
  return { ok: res.ok && j.ResponseCode === '0', reference: j.ConversationID };
}

module.exports = { stkPush, parseCallback, b2cPayout, isMock: m.env === 'mock' };
