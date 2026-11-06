// Only registered by the API in local/development mode.
import crypto from 'node:crypto';
import { withTransaction } from '../db.js';
import { badRequest } from '../errors.js';

export const TEST_USERS = { buyer: 'transfer-test-buyer', seller: 'transfer-test-seller' };

export async function createTransferFixture() {
  return withTransaction(async (client) => {
    for (const [role, id] of Object.entries(TEST_USERS)) {
      await client.query(`INSERT INTO users (id, display_name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
        [id, `Test ${role === 'buyer' ? 'Buyer' : 'Seller'}`]);
    }
    const eventId = 'transfer-test-' + crypto.randomUUID();
    await client.query(`INSERT INTO events (id, name, venue, starts_at)
      VALUES ($1, 'Ticket transfer practice', 'Test venue · no real ticket', now() + interval '7 days')`, [eventId]);
    const { rows: [listing] } = await client.query(`INSERT INTO listings
      (event_id, seller_id, tier, section, seat_label, price_cents, qty_total, qty_available)
      VALUES ($1, $2, 'ga', 'Test section', 'Practice ticket', 1000, 2, 2) RETURNING id`, [eventId, TEST_USERS.seller]);
    return { eventId, listingId: listing.id };
  });
}

export async function testSession(role) {
  if (!Object.hasOwn(TEST_USERS, role)) throw badRequest('choose buyer or seller');
  return withTransaction(async (client) => {
    const id = TEST_USERS[role];
    await client.query(`INSERT INTO users (id, display_name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
      [id, `Test ${role === 'buyer' ? 'Buyer' : 'Seller'}`]);
    const token = crypto.randomBytes(32).toString('base64url');
    await client.query(`INSERT INTO sessions (token_hash, user_id, expires_at)
      VALUES ($1, $2, now() + interval '1 day')`, [crypto.createHash('sha256').update(token).digest('hex'), id]);
    return token;
  });
}
