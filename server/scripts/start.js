// Production start, used by Railway (and any host that runs `npm start`):
// migrations, first-run data, then the API and the background worker in one process.
// The host provides DATABASE_URL and PORT; see DEPLOY.md for the other settings.
import { config } from '../config.js';
import { query, closePool } from '../db.js';
import { migrate } from '../migrate.js';
import { seedDemoData } from '../seed.js';
import { buildApp } from '../app.js';
import { startRealtime, stopRealtime } from '../realtime.js';
import { startWorker } from '../worker.js';
import { stopBoss } from '../jobs.js';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. On Railway, add a Postgres database and reference its DATABASE_URL.');
  process.exit(1);
}
if (config.isProduction && config.emailProvider === 'dev') {
  console.warn('[setup] EMAIL_PROVIDER is dev: sign-in codes only print here, so testers cannot sign in. Set EMAIL_PROVIDER=resend.');
}
if (config.isProduction && config.paymentProvider !== 'stripe') {
  console.warn('[setup] PAYMENT_PROVIDER is not stripe: checkout is turned off in production. Set PAYMENT_PROVIDER=stripe with test keys.');
}

await migrate({ log: (m) => console.log('[db]', m) });
const { rows: [{ n }] } = await query('SELECT count(*)::int AS n FROM users');
if (!n) {
  // Games and past sales (for the market average). Sample listings only if asked for:
  // their sellers have no Stripe accounts, so nobody could really buy them.
  const listings = process.env.SEED_SAMPLE_LISTINGS === 'true';
  await seedDemoData({ listings });
  console.log(`[db] first run: added the games${listings ? ' and sample listings' : ''}`);
}

await startRealtime();
await startWorker();
const app = buildApp();
await app.listen({ port: config.port, host: '0.0.0.0' });
console.log(`Teezy running on port ${config.port} (${config.publicUrl})`);

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  for (const step of [() => app.close(), stopBoss, stopRealtime, closePool]) {
    try { await step(); } catch { /* already closed */ }
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
