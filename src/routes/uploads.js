// Private file access: trip photos and KYC documents are only visible to the people involved (and admins).
const router = require('express').Router();
const path = require('path');
const db = require('../db');
const { verifyAccess } = require('../middleware/auth');
const { wrap } = require('../utils');

const DIR = path.join(__dirname, '..', '..', 'uploads');

router.get('/:file', wrap(async (req, res) => {
  const file = req.params.file;
  if (!/^[a-f0-9]{24}\.(png|jpg|webp)$/.test(file)) return res.status(404).end();
  let user;
  try { const p = verifyAccess(String(req.query.token || '')); user = { id: Number(p.sub), role: p.role }; }
  catch { return res.status(401).end(); }

  const url = `/uploads/${file}`;
  let allowed = user.role === 'ADMIN';
  if (!allowed) {
    const r = await db.query(
      `SELECT 1 FROM trip_photos p JOIN trips t ON t.id=p.trip_id WHERE p.photo_url=$1 AND (t.client_id=$2 OR t.driver_id=$2)
       UNION ALL
       SELECT 1 FROM driver_profiles WHERE user_id=$2 AND $1 IN (id_url, license_url, good_conduct_url) LIMIT 1`, [url, user.id]);
    allowed = r.rowCount > 0;
  }
  if (!allowed) return res.status(403).end();
  res.set('Cache-Control', 'private, max-age=3600');
  res.sendFile(path.join(DIR, file));
}));

module.exports = router;
