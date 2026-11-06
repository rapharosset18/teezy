// Fans Postgres NOTIFY events out to Server-Sent Events streams. Works across processes:
// the worker's notifications reach browsers connected to any API server.
import pg from 'pg';
import { config } from './config.js';

const streams = new Set(); // { userId, send }
const RECONNECT_MS = 1000;
let listener = null;
let stopping = false;
let reconnect = null;

function scheduleReconnect() {
  if (stopping || reconnect) return;
  reconnect = setTimeout(async () => {
    reconnect = null;
    try { await connect(); console.log('[realtime] reconnected'); }
    catch (err) { console.error('[realtime] reconnect failed:', err.message); scheduleReconnect(); }
  }, RECONNECT_MS);
}

async function connect() {
  const client = new pg.Client({ connectionString: config.databaseUrl });
  client.on('error', (err) => console.error('[realtime] listener error:', err.message));
  // A dropped connection must not silently end live updates for every open browser.
  client.on('end', () => { if (client === listener) { listener = null; scheduleReconnect(); } });
  client.on('notification', (msg) => {
    let event;
    try { event = JSON.parse(msg.payload); } catch { return; }
    for (const s of streams) {
      if (event.userId && event.userId !== s.userId) continue;
      s.send(event);
    }
  });
  await client.connect();
  await client.query('LISTEN teezy');
  listener = client;
}

export async function startRealtime() {
  stopping = false;
  if (!listener) await connect();
}

export async function stopRealtime() {
  stopping = true;
  clearTimeout(reconnect);
  reconnect = null;
  const client = listener;
  listener = null;
  if (client) await client.end();
}

export function subscribe(userId, send) {
  const entry = { userId, send };
  streams.add(entry);
  return () => streams.delete(entry);
}
