const router = require('express').Router();
const { z } = require('zod');
const db = require('../db');
const rt = require('../realtime');
const { sendSms } = require('../services/sms');
const { authenticate } = require('../middleware/auth');
const { wrap } = require('../utils');

router.post('/trigger', authenticate, wrap(async (req, res) => {
  const b = z.object({
    tripId: z.number().int().positive().optional(),
    lat: z.number().min(-90).max(90).optional(), lng: z.number().min(-180).max(180).optional(),
  }).parse(req.body || {});

  const { rows } = await db.query(
    `INSERT INTO sos_alerts (user_id, trip_id, lat, lng) VALUES ($1,$2,$3,$4) RETURNING *`,
    [req.user.id, b.tripId ?? null, b.lat ?? null, b.lng ?? null]);
  const alert = rows[0];
  const u = (await db.query(`SELECT name, phone FROM users WHERE id=$1`, [req.user.id])).rows[0];
  rt.toAdmins('sos:alert', { ...alert, name: u.name, phone: u.phone });

  // SMS emergency contacts with a live tracking link when we have a trip.
  let link = '';
  if (b.tripId) {
    const t = (await db.query(`SELECT share_token FROM trips WHERE id=$1 AND (client_id=$2 OR driver_id=$2)`, [b.tripId, req.user.id])).rows[0];
    if (t) link = ` Track: ${req.protocol}://${req.get('host')}/share/?t=${t.share_token}`;
  }
  const where = b.lat ? ` Location: https://maps.google.com/?q=${b.lat},${b.lng}.` : '';
  const contacts = await db.query(`SELECT contact_phone FROM emergency_contacts WHERE user_id=$1`, [req.user.id]);
  await Promise.all(contacts.rows.map((c) =>
    sendSms(c.contact_phone, `EMERGENCY: ${u.name || u.phone} pressed the SafeRide SOS button.${where}${link}`).catch(() => {})));
  res.status(201).json({ ok: true, alertId: alert.id, notifiedContacts: contacts.rowCount });
}));

module.exports = router;
