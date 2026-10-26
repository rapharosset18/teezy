// Fans Postgres NOTIFY events out to Server-Sent Events streams. Works across processes:
// the worker's notifications reach browsers connected to any API server.
import pg from 'pg';
import { config } from './config.js';

const streams = new Set(); // { userId, send }
let listener = null;

export async function startRealtime() {
  if (listener) return;
  listener = new pg.Client({ connectionString: config.databaseUrl });
  listener.on('error', (err) => console.error('[realtime] listener error:', err.message));
  await listener.connect();
  listener.on('notification', (msg) => {
    let event;
    try { event = JSON.parse(msg.payload); } catch { return; }
    for (const s of streams) {
      if (event.type === 'notification' && event.userId !== s.userId) continue;
      s.send(event);
    }
  });
  await listener.query('LISTEN teezy');
}

export async function stopRealtime() {
  if (listener) await listener.end();
  listener = null;
}

export function subscribe(userId, send) {
  const entry = { userId, send };
  streams.add(entry);
  return () => streams.delete(entry);
}
