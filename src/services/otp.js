const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const { HttpError } = require('../utils');
const { sendSms } = require('./sms');

const OTP_TTL_MIN = 5;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_SEC = 30;

const hash = (phone, code) =>
  crypto.createHmac('sha256', config.jwt.accessSecret).update(`${phone}:${code}`).digest('hex');

async function requestOtp(phone) {
  const last = await db.query(
    `SELECT created_at FROM otp_codes WHERE phone=$1 ORDER BY created_at DESC LIMIT 1`, [phone]);
  if (last.rows[0] && Date.now() - new Date(last.rows[0].created_at) < RESEND_COOLDOWN_SEC * 1000) {
    throw new HttpError(429, `Please wait ${RESEND_COOLDOWN_SEC}s before requesting another code`, 'OTP_COOLDOWN');
  }
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await db.query(
    `INSERT INTO otp_codes (phone, code_hash, expires_at) VALUES ($1,$2, now() + ($3 || ' minutes')::interval)`,
    [phone, hash(phone, code), OTP_TTL_MIN]);
  await sendSms(phone, `Your SafeRide code is ${code}. It expires in ${OTP_TTL_MIN} minutes.`);
  // Dev convenience only: never returned in production.
  return config.isProd || (config.sms.username && config.sms.apiKey) ? {} : { devCode: code };
}

async function verifyOtp(phone, code) {
  const { rows } = await db.query(
    `SELECT * FROM otp_codes WHERE phone=$1 AND consumed=false AND expires_at > now()
     ORDER BY created_at DESC LIMIT 1`, [phone]);
  const row = rows[0];
  if (!row) throw new HttpError(400, 'Code expired or not requested', 'OTP_INVALID');
  if (row.attempts >= MAX_ATTEMPTS) throw new HttpError(429, 'Too many attempts, request a new code', 'OTP_LOCKED');
  const ok = crypto.timingSafeEqual(Buffer.from(row.code_hash), Buffer.from(hash(phone, code)));
  if (!ok) {
    await db.query(`UPDATE otp_codes SET attempts = attempts + 1 WHERE id=$1`, [row.id]);
    throw new HttpError(400, 'Incorrect code', 'OTP_INVALID');
  }
  await db.query(`UPDATE otp_codes SET consumed=true WHERE id=$1`, [row.id]);
}

module.exports = { requestOtp, verifyOtp };
