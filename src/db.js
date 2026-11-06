const { Pool, types } = require('pg');
const config = require('./config');

// BIGINT (oid 20) comes back as a string by default; our ids/counters are far below 2^53, and
// every `trip.driver_id !== user.id` style check in the code assumes numbers.
types.setTypeParser(20, (v) => Number(v));

const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });
pool.on('error', (e) => console.error('[db] idle client error', e.message));

const query = (text, params) => pool.query(text, params);

async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, tx };
