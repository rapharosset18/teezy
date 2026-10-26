// "Desired Ticket" alerts: CRUD for the profile, and the background check that runs
// when a listing is created or its price drops.
import { config } from '../config.js';
import { query, withTransaction } from '../db.js';
import { badRequest, notFound, requireInt } from '../errors.js';
import { notificationDto, sendPush } from './push.js';

function dto(r) {
  return {
    id: r.id,
    userId: r.user_id,
    eventId: r.event_id,
    tier: r.tier ?? 'any',
    qty: r.qty,
    maxPriceCents: r.max_price_cents,
    paused: r.paused,
    lastNotifiedAt: r.last_notified_at,
    createdAt: r.created_at,
  };
}

// Listings the entry would already match, so the UI can say "3 available now".
async function availableNow(entry) {
  const { rows: [r] } = await query(
    `SELECT count(*)::int AS n FROM listings
     WHERE event_id = $1 AND status = 'active' AND ($2::text IS NULL OR tier = $2)
       AND seller_id <> $3 AND price_cents <= $4 AND qty_available >= $5`,
    [entry.event_id, entry.tier, entry.user_id, entry.max_price_cents, entry.qty],
  );
  return r.n;
}

export async function listDesired(userId) {
  const { rows } = await query('SELECT * FROM desired_tickets WHERE user_id = $1 ORDER BY created_at', [userId]);
  return rows.map(dto);
}

export async function createDesired(userId, input) {
  if (!input.eventId) throw badRequest('eventId is required');
  const qty = requireInt(input.qty ?? 1, 'qty', { min: 1, max: 10 });
  const maxPriceCents = requireInt(input.maxPriceCents, 'maxPriceCents', { min: 1 });
  const tier = input.tier && input.tier !== 'any' ? input.tier : null;
  const { rows: [row] } = await query(
    `INSERT INTO desired_tickets (user_id, event_id, tier, qty, max_price_cents)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [userId, input.eventId, tier, qty, maxPriceCents],
  );
  return { ...dto(row), availableNow: await availableNow(row) };
}

export async function updateDesired(userId, id, patch) {
  const sets = [];
  const values = [id, userId];
  const add = (column, value) => { values.push(value); sets.push(`${column} = $${values.length}`); };
  if (patch.paused !== undefined) add('paused', !!patch.paused);
  if (patch.maxPriceCents !== undefined) add('max_price_cents', requireInt(patch.maxPriceCents, 'maxPriceCents', { min: 1 }));
  if (patch.qty !== undefined) add('qty', requireInt(patch.qty, 'qty', { min: 1, max: 10 }));
  if (patch.tier !== undefined) add('tier', patch.tier && patch.tier !== 'any' ? patch.tier : null);
  if (!sets.length) throw badRequest('nothing to update');
  const { rows: [row] } = await query(
    `UPDATE desired_tickets SET ${sets.join(', ')}, updated_at = clock_timestamp()
     WHERE id = $1 AND user_id = $2 RETURNING *`,
    values,
  );
  if (!row) throw notFound('desired ticket');
  return dto(row);
}

export async function deleteDesired(userId, id) {
  const { rowCount } = await query('DELETE FROM desired_tickets WHERE id = $1 AND user_id = $2', [id, userId]);
  if (!rowCount) throw notFound('desired ticket');
}

function money(cents) {
  return '$' + (cents % 100 ? (cents / 100).toFixed(2) : String(cents / 100));
}

// The job handler. Finds every entry this listing now satisfies and notifies each owner
// at most once per listing, and not more often than the cooldown per entry.
export async function checkDesiredForListing({ listingId, trigger }) {
  const { rows: candidates } = await query(
    `SELECT d.id
     FROM desired_tickets d
     JOIN listings l ON l.id = $1
     WHERE NOT d.paused
       AND l.status = 'active'
       AND d.event_id = l.event_id
       AND (d.tier IS NULL OR d.tier = l.tier)
       AND l.price_cents <= d.max_price_cents
       AND l.qty_available >= d.qty
       AND d.user_id <> l.seller_id`,
    [listingId],
  );

  const sent = [];
  for (const { id } of candidates) {
    const notification = await withTransaction(async (client) => {
      // Lock the entry so two jobs for two listings can't both slip past the cooldown.
      const { rows: [d] } = await client.query(
        `SELECT d.*, l.price_cents, l.tier AS listing_tier, e.name AS event_name, u.display_name AS seller_name
         FROM desired_tickets d
         JOIN listings l ON l.id = $2
         JOIN events e ON e.id = d.event_id
         JOIN users u ON u.id = l.seller_id
         WHERE d.id = $1 AND NOT d.paused
         FOR UPDATE OF d`,
        [id, listingId],
      );
      if (!d) return null; // deleted or paused since the candidate query
      if (d.last_notified_at && Date.now() - new Date(d.last_notified_at).getTime() < config.alertCooldownMs) return null;
      const { rowCount } = await client.query(
        `INSERT INTO desired_ticket_notifications (desired_ticket_id, listing_id, trigger)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [id, listingId, trigger],
      );
      if (!rowCount) return null; // already told them about this listing
      await client.query('UPDATE desired_tickets SET last_notified_at = clock_timestamp() WHERE id = $1', [id]);

      const price = money(d.price_cents);
      const params = new URLSearchParams({
        event: d.event_id, tier: d.tier ?? 'any', qty: String(d.qty), price: String(d.max_price_cents / 100),
      });
      const { rows: [n] } = await client.query(
        `INSERT INTO notifications (user_id, kind, title, body, deep_link, data)
         VALUES ($1, 'desired_ticket', $2, $3, $4, $5) RETURNING *`,
        [
          d.user_id,
          trigger === 'price_drop' ? `Your desired ticket dropped to ${price}` : `Your desired ticket hit ${price}`,
          `${d.event_name} · ${d.seller_name} · under your ${money(d.max_price_cents)} max. Tap to buy.`,
          // Opens the price slider pre-set to the entry's max price.
          `/?${params}`,
          { desiredTicketId: id, listingId, trigger, eventId: d.event_id, tier: d.tier ?? 'any', qty: d.qty, maxPriceCents: d.max_price_cents, priceCents: d.price_cents },
        ],
      );
      return notificationDto(n);
    });
    if (notification) {
      await sendPush(notification);
      sent.push(notification);
    }
  }
  return sent;
}
