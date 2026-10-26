// Demo only: makes the market move toward a desired ticket so the alert pipeline can be
// seen end to end. It writes as another seller through the normal listing service, so the
// job queue, matching rules, cooldown and push all run exactly as they would for real.
import { query } from '../db.js';
import { notFound } from '../errors.js';
import { createListing, updateListing } from './listings.js';

const SIM_SELLERS = ['jordan-m', 'casey-l', 'avery-d'];
let next = 0;

export async function simulateMarketMove(userId, desiredTicketId) {
  const { rows: [d] } = await query('SELECT * FROM desired_tickets WHERE id = $1 AND user_id = $2', [desiredTicketId, userId]);
  if (!d) throw notFound('desired ticket');

  // A listing a little above the max drops its price to it...
  const { rows: [close] } = await query(
    `SELECT * FROM listings
     WHERE event_id = $1 AND status = 'active' AND ($2::text IS NULL OR tier = $2)
       AND seller_id <> $3 AND qty_available >= $4
       AND price_cents > $5 AND price_cents <= $5 * 1.4
     ORDER BY price_cents LIMIT 1`,
    [d.event_id, d.tier, userId, d.qty, d.max_price_cents],
  );
  if (close) {
    const listing = await updateListing(close.id, close.seller_id, { priceCents: d.max_price_cents });
    return { action: 'price_drop', listing };
  }

  // ...or a new seller lists at it.
  const sellerId = SIM_SELLERS[next++ % SIM_SELLERS.length];
  const { rows: [ev] } = await query(
    `SELECT coalesce($2::text, (SELECT tier FROM listings WHERE event_id = $1 GROUP BY tier ORDER BY count(*) DESC LIMIT 1), 'ga') AS tier`,
    [d.event_id, d.tier],
  );
  const listing = await createListing(sellerId, {
    eventId: d.event_id,
    tier: ev.tier,
    qty: d.qty,
    priceCents: d.max_price_cents,
    seatLabel: `${d.qty} seat${d.qty > 1 ? 's' : ''} together`,
  });
  return { action: 'created', listing };
}
