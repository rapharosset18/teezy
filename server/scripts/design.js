// A second local server for UI and design work, fully separate from `npm run dev`:
// its own Postgres (.pgdata-design, port 54339) and its own web port (3100).
//   npm run design            keeps your data between runs
//   npm run design -- --reset  reseeds the demo data
// Runs the normal dev script on top, so it stays in step with dev.js.
import fs from 'node:fs';
import path from 'node:path';
import { startEmbeddedPg } from '../embeddedPg.js';

const PG_DIR = '.pgdata-design';
process.env.PORT ||= '3100';

const pg = await startEmbeddedPg({ dir: PG_DIR, port: 54339 });
process.env.DATABASE_URL = pg.url;

// dev.js exits the process on Ctrl-C without knowing about this Postgres, so stop it on the way out.
process.on('exit', () => {
  try {
    const pid = Number(fs.readFileSync(path.join(PG_DIR, 'postmaster.pid'), 'utf8').split('\n')[0]);
    process.kill(pid, 'SIGINT'); // Postgres "fast" shutdown
  } catch { /* already stopped */ }
});

await import('./dev.js');
