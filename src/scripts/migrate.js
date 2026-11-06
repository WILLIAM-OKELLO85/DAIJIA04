const fs = require('fs');
const path = require('path');
const db = require('../db');

(async () => {
  const dir = path.join(__dirname, '..', '..', 'db', 'migrations');
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const done = new Set((await db.query(`SELECT name FROM schema_migrations`)).rows.map((r) => r.name));
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    console.log('applying', f);
    await db.tx(async (c) => {
      await c.query(fs.readFileSync(path.join(dir, f), 'utf8'));
      await c.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [f]);
    });
  }
  console.log('migrations up to date');
  await db.pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
