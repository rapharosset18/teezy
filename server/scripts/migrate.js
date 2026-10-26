// Applies pending migrations to DATABASE_URL (production, staging, a hosted Postgres).
import { migrate } from '../migrate.js';
import { closePool } from '../db.js';

if (!process.env.DATABASE_URL) {
  console.error('Set DATABASE_URL. For local development, `npm run dev` migrates automatically.');
  process.exit(1);
}
await migrate({ log: console.log });
await closePool();
