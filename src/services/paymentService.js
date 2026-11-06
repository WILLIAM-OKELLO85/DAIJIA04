const db = require('../db');
const config = require('../config');
const mpesa = require('./mpesa');
const rt = require('./../realtime');
const trips = require('./tripService');
const { sendSms } = require('./sms');
const { HttpError } = require('../utils');

const MIN_PAYOUT = 100;

async function initiate(clientId, tripId, phoneOverride) {
  const trip = await trips.getTrip(tripId);
  if (trip.client_id !== clientId) throw new HttpError(403, 'Not your trip', 'FORBIDDEN');
  if (!['COMPLETED', 'PAYMENT_FAILED'].includes(trip.status)) throw new HttpError(409, `Trip is ${trip.status}; nothing to pay`, 'BAD_STATE');

  const pend = await db.query(`SELECT * FROM payments WHERE trip_id=$1 AND status='PENDING' AND created_at > now() - interval '2 minutes'`, [tripId]);
  if (pend.rows[0]) return { paymentId: pend.rows[0].id, status: 'PENDING', message: 'Check your phone for the M-Pesa prompt' };

  const phone = phoneOverride || (await db.query(`SELECT phone FROM users WHERE id=$1`, [clientId])).rows[0].phone;
  const amount = Number(trip.final_fare_kes) + Number(trip.cancel_fee_kes || 0);
  const r = await mpesa.stkPush({ phone, amount, tripId });
  const { rows } = await db.query(
    `INSERT INTO payments (trip_id, amount_kes, phone, checkout_request_id, merchant_request_id)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`, [tripId, amount, phone, r.checkoutRequestId, r.merchantRequestId]);

  if (r.mock) { // simulate the customer entering their PIN
    setTimeout(() => handleCallback({
      checkoutRequestId: r.checkoutRequestId, success: true, resultDesc: 'mock ok',
      receipt: `MOCK${Date.now().toString(36).toUpperCase()}`, amount,
    }).catch((e) => console.error('[mpesa:mock]', e.message)), 2500);
  }
  return { paymentId: rows[0].id, status: 'PENDING', message: 'Check your phone for the M-Pesa prompt' };
}

// Idempotent: Safaricom may retry callbacks.
async function handleCallback(cb) {
  const result = await db.tx(async (c) => {
    const { rows } = await c.query(`SELECT * FROM payments WHERE checkout_request_id=$1 FOR UPDATE`, [cb.checkoutRequestId]);
    const pay = rows[0];
    if (!pay) return { ignored: true };
    if (pay.status !== 'PENDING') return { duplicate: true };

    if (!cb.success) {
      const cancelled = cb.resultCode === 1032;
      await c.query(`UPDATE payments SET status=$2, failure_reason=$3, updated_at=now() WHERE id=$1`,
        [pay.id, cancelled ? 'CANCELLED' : 'FAILED', cb.resultDesc]);
      await c.query(`UPDATE trips SET status='PAYMENT_FAILED' WHERE id=$1 AND status='COMPLETED'`, [pay.trip_id]);
      await c.query(`INSERT INTO trip_events (trip_id,type,payload) VALUES ($1,'PAYMENT_FAILED',$2)`, [pay.trip_id, { reason: cb.resultDesc }]);
      return { failed: true, tripId: pay.trip_id, reason: cb.resultDesc };
    }
    // Underpayment guard
    if (cb.amount !== undefined && Number(cb.amount) + 0.5 < Math.floor(Number(pay.amount_kes))) {
      await c.query(`UPDATE payments SET status='FAILED', failure_reason='Amount mismatch', updated_at=now() WHERE id=$1`, [pay.id]);
      return { failed: true, tripId: pay.trip_id, reason: 'Amount mismatch' };
    }
    await c.query(`UPDATE payments SET status='SUCCESS', mpesa_receipt=$2, updated_at=now() WHERE id=$1`, [pay.id, cb.receipt]);
    const t = (await c.query(`UPDATE trips SET status='PAID' WHERE id=$1 AND status IN ('COMPLETED','PAYMENT_FAILED') RETURNING *`, [pay.trip_id])).rows[0];
    if (t) {
      await c.query(`INSERT INTO trip_events (trip_id,type,payload) VALUES ($1,'PAID',$2)`, [t.id, { receipt: cb.receipt }]);
      await c.query(`UPDATE driver_profiles SET wallet_balance_kes = wallet_balance_kes + $2, trips_completed = trips_completed + 1 WHERE user_id=$1`,
        [t.driver_id, t.driver_earning_kes]);
      if (t.promo_code) await c.query(`UPDATE promo_codes SET used_count = used_count + 1 WHERE code=$1`, [t.promo_code]);
    }
    return { paid: true, tripId: pay.trip_id, receipt: cb.receipt };
  });

  if (result.tripId) {
    const trip = await trips.getTrip(result.tripId);
    await trips.push(trip);
    if (result.paid) {
      const u = (await db.query(`SELECT phone FROM users WHERE id=$1`, [trip.client_id])).rows[0];
      sendSms(u.phone, `SafeRide receipt: KES ${trip.final_fare_kes} paid for trip #${trip.id}. M-Pesa ref ${result.receipt}. Thank you!`).catch(() => {});
    }
  }
  return result;
}

async function requestPayout(driverId) {
  const prof = (await db.query(`SELECT wallet_balance_kes FROM driver_profiles WHERE user_id=$1`, [driverId])).rows[0];
  if (!prof || Number(prof.wallet_balance_kes) < MIN_PAYOUT) throw new HttpError(422, `Minimum payout is KES ${MIN_PAYOUT}`, 'BELOW_MIN');
  const phone = (await db.query(`SELECT phone FROM users WHERE id=$1`, [driverId])).rows[0].phone;

  // Debit first (atomically) so a double-tap cannot pay twice.
  const payout = await db.tx(async (c) => {
    const w = await c.query(
      `UPDATE driver_profiles SET wallet_balance_kes = 0 WHERE user_id=$1 AND wallet_balance_kes >= $2 RETURNING wallet_balance_kes`, [driverId, MIN_PAYOUT]);
    if (!w.rows[0]) throw new HttpError(409, 'Balance changed, try again', 'RACE');
    const amt = Number(prof.wallet_balance_kes);
    const p = await c.query(`INSERT INTO payouts (driver_id, amount_kes) VALUES ($1,$2) RETURNING *`, [driverId, amt]);
    return p.rows[0];
  });
  try {
    const r = await mpesa.b2cPayout({ phone, amount: Number(payout.amount_kes), reference: `PO${payout.id}` });
    if (!r.ok) throw new Error('B2C rejected');
    await db.query(`UPDATE payouts SET status=$2, reference=$3 WHERE id=$1`, [payout.id, mpesa.isMock ? 'SUCCESS' : 'PENDING', r.reference]);
    return { payoutId: payout.id, amount: Number(payout.amount_kes), status: mpesa.isMock ? 'SUCCESS' : 'PENDING' };
  } catch (e) {
    await db.tx(async (c) => {
      await c.query(`UPDATE payouts SET status='FAILED' WHERE id=$1`, [payout.id]);
      await c.query(`UPDATE driver_profiles SET wallet_balance_kes = wallet_balance_kes + $2 WHERE user_id=$1`, [driverId, payout.amount_kes]);
    });
    throw new HttpError(502, 'Payout failed, balance restored', 'PAYOUT_FAILED');
  }
}

// Async B2C result from Daraja
async function handleB2CResult(body) {
  const r = body?.Result;
  if (!r) return;
  const ok = r.ResultCode === 0;
  const { rows } = await db.query(`SELECT * FROM payouts WHERE reference=$1`, [r.ConversationID]);
  const p = rows[0];
  if (!p || p.status !== 'PENDING') return;
  if (ok) await db.query(`UPDATE payouts SET status='SUCCESS' WHERE id=$1`, [p.id]);
  else await db.tx(async (c) => {
    await c.query(`UPDATE payouts SET status='FAILED' WHERE id=$1`, [p.id]);
    await c.query(`UPDATE driver_profiles SET wallet_balance_kes = wallet_balance_kes + $2 WHERE user_id=$1`, [p.driver_id, p.amount_kes]);
  });
}

module.exports = { initiate, handleCallback, requestPayout, handleB2CResult };
