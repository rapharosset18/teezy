// One command for local development: local Postgres, migrations, demo data, API, worker.
//   npm run dev            keeps your data between runs
//   npm run dev -- --reset  reseeds the demo data
import { config } from '../config.js';
import { startEmbeddedPg } from '../embeddedPg.js';

const pg = process.env.DATABASE_URL ? null : await startEmbeddedPg({ dir: '.pgdata', port: 54329 });
if (pg) config.databaseUrl = pg.url;

const { query, closePool } = await import('../db.js');
const { migrate } = await import('../migrate.js');
const { seedDemoData, resetDemoData } = await import('../seed.js');
const { buildApp } = await import('../app.js');
const { startRealtime, stopRealtime } = await import('../realtime.js');
const { startWorker } = await import('../worker.js');
const { stopBoss } = await import('../jobs.js');

await migrate({ log: (m) => console.log('[db]', m) });
const { rows: [{ n }] } = await query('SELECT count(*)::int AS n FROM users');
if (process.argv.includes('--reset')) await resetDemoData();
if (!n || process.argv.includes('--reset')) {
  await seedDemoData();
  console.log('[db] seeded demo data');
}

await startRealtime();
await startWorker({ pollingIntervalSeconds: 0.5 });
const app = buildApp();
await app.listen({ port: config.port, host: '127.0.0.1' });
console.log(`Teezy running at http://localhost:${config.port}`);

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  // Ctrl-C also reaches Postgres, so connections may already be gone; finish regardless.
  for (const step of [() => app.close(), stopBoss, stopRealtime, closePool, () => pg && pg.stop()]) {
    try { await step(); } catch { /* already closed */ }
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
