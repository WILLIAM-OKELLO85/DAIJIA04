const fs = require('fs');
const path = require('path');
const db = require('../db');

(async () => {
  await db.query(fs.readFileSync(path.join(__dirname, '..', '..', 'db', 'seed.sql'), 'utf8'));
  console.log('seeded zones, demo venue, promo LAUNCH20');
  await db.pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
