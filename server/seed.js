// Demo data matching the web demo's listings (web/classic.html), so the feed cards and the
// order book agree. Prices are per ticket.
import { withTransaction } from './db.js';

const USERS = [
  ['mia', 'Mia Chen', 5.0],
  ['priya', 'Priya S.', 5.0], ['taylor', 'Taylor B.', 4.9], ['sam', 'Sam K.', 4.9],
  ['riley', 'Riley P.', 4.4], ['chris', 'Chris T.', 4.7], ['ana', 'Ana R.', 5.0],
  ['grant', 'Grant P.', 4.5], ['noah', 'Noah W.', 4.8], ['lena', 'Lena V.', 4.9], ['bella', 'Bella M.', 4.6],
  // Sellers the demo's "market move" uses.
  ['jordan-m', 'Jordan M.', 4.8], ['casey-l', 'Casey L.', 4.9], ['avery-d', 'Avery D.', 4.7],
  // Stand-ins for past trades, which feed the market average.
  ['past-seller', 'Past seller', 4.8], ['past-buyer', 'Past buyer', 4.8],
];

const EVENTS = [
  ['fb-nd', 'USC vs Oregon', 'Coliseum', '2026-11-21T17:00:00-08:00'],
  ['sigchi-formal', 'Sigma Chi Formal', 'Off-campus venue', '2026-11-08T21:00:00-08:00'],
  ['aka-social', 'AKA Fall Social', 'Off-campus venue', '2026-10-31T21:00:00-07:00'],
];

// [seller, event, tier, section, seat label, price per ticket ($), qty, listed minutes ago]
const LISTINGS = [
  ['priya', 'fb-nd', 'ga', '108', 'Sec 108 · Row 5 · GA pair', 65, 2, 1440],
  ['taylor', 'fb-nd', 'ga', '110', 'Sec 110 · Row 22 · 2 seats', 55, 2, 300],
  ['sam', 'fb-nd', 'ga', '106', 'Sec 106 · Row 18 · Seat 2', 50, 1, 120],
  ['riley', 'fb-nd', 'student', '25', 'Sec 25 · Row 12 · 2 seats', 38, 2, 45],
  ['chris', 'fb-nd', 'student', '27', 'Sec 27 · Row 40 · Seat 8', 48, 1, 600],
  ['ana', 'fb-nd', 'reserved', '115', 'Sec 115 · Row 3 · 4 seats', 80, 4, 900],
  ['grant', 'sigchi-formal', 'entry', null, 'Sigma Chi Formal · wristband ×1', 40, 1, 400],
  ['noah', 'sigchi-formal', 'entry', null, 'Sigma Chi Formal · wristband ×2', 35, 2, 200],
  ['lena', 'aka-social', 'entry', null, 'AKA Fall Social · wristband ×2', 30, 2, 500],
  ['bella', 'aka-social', 'entry', null, 'AKA Fall Social · wristband ×1', 28, 1, 90],
];

// [event, tier, price per ticket ($), days ago]
const PAST_SALES = [
  ['fb-nd', 'ga', 55, 2], ['fb-nd', 'ga', 58, 3], ['fb-nd', 'ga', 60, 5], ['fb-nd', 'ga', 62, 6], ['fb-nd', 'ga', 65, 9], ['fb-nd', 'ga', 70, 12],
  ['fb-nd', 'student', 42, 1], ['fb-nd', 'student', 45, 4], ['fb-nd', 'student', 48, 7], ['fb-nd', 'student', 50, 8], ['fb-nd', 'student', 52, 15],
  ['fb-nd', 'reserved', 78, 3], ['fb-nd', 'reserved', 85, 10], ['fb-nd', 'reserved', 90, 20],
  ['aka-social', 'entry', 32, 2],
];

export const DEMO_TABLES = [
  'sessions', 'email_login_codes', 'notifications', 'push_tokens', 'desired_ticket_notifications', 'desired_tickets',
  'order_fills', 'orders', 'listings', 'events', 'users',
];

export async function resetDemoData() {
  await withTransaction((client) => client.query(`TRUNCATE ${DEMO_TABLES.join(', ')} CASCADE`));
}

export async function seedDemoData() {
  await withTransaction(async (client) => {
    for (const [id, name, rating] of USERS) {
      await client.query('INSERT INTO users (id, display_name, rating) VALUES ($1, $2, $3)', [id, name, rating]);
    }
    for (const [id, name, venue, startsAt] of EVENTS) {
      await client.query('INSERT INTO events (id, name, venue, starts_at) VALUES ($1, $2, $3, $4)', [id, name, venue, startsAt]);
    }
    for (const [seller, event, tier, section, seat, price, qty, ago] of LISTINGS) {
      await client.query(
        `INSERT INTO listings (event_id, seller_id, tier, section, seat_label, price_cents, qty_total, qty_available, priority_timestamp, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7, now() - $8 * interval '1 minute', now() - $8 * interval '1 minute')`,
        [event, seller, tier, section, seat, price * 100, qty, ago],
      );
    }
    for (const [event, tier, price, daysAgo] of PAST_SALES) {
      const when = `now() - ${Number(daysAgo)} * interval '1 day'`;
      const { rows: [l] } = await client.query(
        `INSERT INTO listings (event_id, seller_id, tier, price_cents, qty_total, qty_available, status, created_at)
         VALUES ($1, 'past-seller', $2, $3, 1, 0, 'sold', ${when}) RETURNING id`,
        [event, tier, price * 100],
      );
      const fee = Math.round(price * 100 * 0.05);
      const { rows: [o] } = await client.query(
        `INSERT INTO orders (buyer_id, event_id, tier, qty, max_price_cents, subtotal_cents, buyer_fee_cents, total_cents,
                             status, payment_expires_at, paid_at, created_at)
         VALUES ('past-buyer', $1, $2, 1, $3, $3, $4, $3::int + $4::int, 'paid', ${when}, ${when}, ${when}) RETURNING id`,
        [event, tier, price * 100, fee],
      );
      await client.query(
        `INSERT INTO order_fills (order_id, listing_id, seller_id, qty, price_cents, escrow_status)
         VALUES ($1, $2, 'past-seller', 1, $3, 'released')`,
        [o.id, l.id, price * 100],
      );
    }
  });
}
