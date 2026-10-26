import { query } from '../db.js';
import { DEMO_TABLES } from '../seed.js';

export const EVENT = 'game';

// Empty book with one event and a handful of users.
export async function resetDb() {
  await query(`TRUNCATE ${DEMO_TABLES.join(', ')} CASCADE`);
  await query(`DELETE FROM pgboss.job`).catch(() => {});
  await query(`INSERT INTO events (id, name, starts_at) VALUES ($1, 'USC vs Notre Dame', now() + interval '10 days'),
                                                              ('other', 'Other game', now() + interval '20 days')`, [EVENT]);
  const users = ['buyer', 'buyer2', 's1', 's2', 's3', 's4', 's5'];
  for (let i = 0; i < 30; i++) users.push(`b${i}`);
  for (const id of users) await query('INSERT INTO users (id, display_name, rating) VALUES ($1, $1, 4.8)', [id]);
}

// Inserts a listing directly, with an explicit place in line when given.
// `listedSecondsAgo` sets priority_timestamp (larger = earlier in line); `priorityAt`
// pins an exact timestamp, for building true ties.
export async function addListing({ seller = 's1', price, qty = 1, tier = 'ga', event = EVENT, listedSecondsAgo = 0, priorityAt = null }) {
  const { rows: [row] } = await query(
    `INSERT INTO listings (event_id, seller_id, tier, price_cents, qty_total, qty_available, priority_timestamp)
     VALUES ($1, $2, $3, $4, $5, $5, coalesce($7::timestamptz, clock_timestamp() - $6 * interval '1 second')) RETURNING *`,
    [event, seller, tier, Math.round(price * 100), qty, listedSecondsAgo, priorityAt],
  );
  return row;
}

export async function getListing(id) {
  const { rows: [row] } = await query('SELECT * FROM listings WHERE id = $1', [id]);
  return row;
}

export const cents = (dollars) => Math.round(dollars * 100);

export function order(overrides = {}) {
  return { buyerId: 'buyer', eventId: EVENT, tier: 'any', qty: 1, maxPriceCents: cents(100), ...overrides };
}
