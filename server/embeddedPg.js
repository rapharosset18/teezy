// Local Postgres for development and tests, run from the project folder.
// Production points DATABASE_URL at a managed Postgres instead.
import fs from 'node:fs';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

// embedded-postgres rejects with `undefined` when the data dir is in use, so check first.
function livePostmasterPid(dir) {
  let pid;
  try {
    pid = Number(fs.readFileSync(path.join(dir, 'postmaster.pid'), 'utf8').split('\n')[0]);
  } catch {
    return null;
  }
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null; // stale pid file from a crash; Postgres cleans it up on start
  }
}

export async function startEmbeddedPg({ dir, port, database = 'teezy', persistent = true }) {
  const pg = new EmbeddedPostgres({
    databaseDir: dir,
    port,
    user: 'teezy',
    password: 'teezy',
    persistent,
    onLog: () => {},
  });
  if (!fs.existsSync(path.join(dir, 'PG_VERSION'))) await pg.initialise();
  const runningPid = livePostmasterPid(dir);
  if (runningPid) {
    throw new Error(`Postgres for ${dir} is already running (pid ${runningPid}). ` +
      'Another `npm run dev` is probably open; stop it first, or stop that pid if it was left behind.');
  }
  await pg.start();
  try {
    await pg.createDatabase(database);
  } catch (err) {
    if (!/already exists/.test(String(err && err.message))) throw err;
  }
  return {
    url: `postgres://teezy:teezy@localhost:${port}/${database}`,
    stop: () => pg.stop(),
  };
}
