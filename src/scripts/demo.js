const fs = require('fs');
const path = require('path');
const db = require('../db');

(async () => {
  const dir = path.join(__dirname, '..', '..', 'db', 'demo');
  const files = fs.readdirSync(dir).filter((file) => file.endsWith('.sql')).sort();
  if (files.length === 0) throw new Error(`No demo SQL files found in ${dir}`);
  await db.tx(async (client) => {
    for (const file of files) {
      await client.query(fs.readFileSync(path.join(dir, file), 'utf8'));
    }
  });
  for (const file of files) console.log('loaded', file);
  console.log('demo dataset loaded');
  await db.pool.end();
})().catch(async (e) => {
  console.error(e);
  await db.pool.end();
  process.exit(1);
});
