// Starts a throwaway Postgres, migrates it, then runs every *.test.js against it.
//   npm test
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after } from 'node:test';
import { config } from '../config.js';
import { startEmbeddedPg } from '../embeddedPg.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA_DIR = path.join(ROOT, '.pgdata-test');
fs.rmSync(DATA_DIR, { recursive: true, force: true });

const pg = await startEmbeddedPg({ dir: DATA_DIR, port: 54330, database: 'teezy_test', persistent: false });
config.databaseUrl = pg.url;

const { migrate } = await import('../migrate.js');
const { closePool } = await import('../db.js');
const { startBoss, stopBoss } = await import('../jobs.js');
await migrate();
await startBoss();

after(async () => {
  await stopBoss();
  await closePool();
  await pg.stop();
});

const dir = path.dirname(fileURLToPath(import.meta.url));
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort()) {
  await import(path.join(dir, file));
}
