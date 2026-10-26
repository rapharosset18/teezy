import pg from 'pg';
import { config } from './config.js';

// bigint (e.g. epoch microseconds) and numeric come back as strings by default.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => (v == null ? null : Number(v)));

let pool = null;

export function getPool() {
  if (!pool) {
    pool = new pg.Pool({ connectionString: config.databaseUrl, max: 20 });
    // An idle connection dropped by the server (restart, Ctrl-C) must not crash the process.
    pool.on('error', (err) => console.error('[db] idle connection error:', err.message));
  }
  return pool;
}

export async function closePool() {
  if (pool) await pool.end();
  pool = null;
}

export function query(text, params) {
  return getPool().query(text, params);
}

export async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Realtime events (book changes, notifications). NOTIFY is transactional, so
// listeners only hear about writes that committed.
export function notify(client, payload) {
  return client.query('SELECT pg_notify($1, $2)', ['teezy', JSON.stringify(payload)]);
}
