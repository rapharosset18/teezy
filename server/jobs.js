// Background jobs on pg-boss, which keeps its queue in the same Postgres database.
// Jobs are enqueued inside the transaction that caused them (pass the client), so a
// rolled-back listing write never sends alerts and a committed one always queues them.
import { PgBoss } from 'pg-boss';
import { config } from './config.js';

export const QUEUES = {
  listingChanged: 'listing-changed',   // { listingId, trigger: 'created' | 'price_drop' }
  orderExpire: 'order-expire',         // { orderId }
};

let boss = null;

export async function startBoss() {
  if (boss) return boss;
  boss = new PgBoss({ connectionString: config.databaseUrl, max: 5 });
  boss.on('error', (err) => console.error('[jobs]', err));
  await boss.start();
  for (const name of Object.values(QUEUES)) await boss.createQueue(name);
  return boss;
}

export async function stopBoss() {
  if (boss) await boss.stop({ graceful: true, wait: true });
  boss = null;
}

export function enqueue(client, name, data, options = {}) {
  if (!boss) throw new Error('job queue not started');
  const db = { executeSql: (text, values) => client.query(text, values) };
  return boss.send(name, data, { ...options, db });
}

// Runs the handlers in this process. In production run this in a separate worker process.
export async function startWorkers(handlers, { pollingIntervalSeconds = 2 } = {}) {
  await startBoss();
  for (const [name, handler] of Object.entries(handlers)) {
    await boss.work(name, { pollingIntervalSeconds }, async (jobs) => {
      for (const job of jobs) await handler(job.data);
    });
  }
}
