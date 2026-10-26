import { withTransaction, notify } from '../db.js';
import { enqueue, QUEUES } from '../jobs.js';
import { badRequest, notFound, forbidden, requireInt } from '../errors.js';
import { alertTrigger } from '../engine/rules.js';

function listingDto(r) {
  return {
    id: r.id,
    eventId: r.event_id,
    sellerId: r.seller_id,
    tier: r.tier,
    section: r.section,
    seatLabel: r.seat_label,
    description: r.description,
    priceCents: r.price_cents,
    qtyTotal: r.qty_total,
    qtyAvailable: r.qty_available,
    acceptsOffers: r.accepts_offers,
    status: r.status,
    priorityTimestamp: r.priority_timestamp,
  };
}

// After any listing write: tell open slider pages, and queue the desired-ticket check
// when the write is one that can newly satisfy an alert. Never runs the check inline.
async function afterWrite(client, before, after) {
  const trigger = alertTrigger(before, after);
  if (trigger) await enqueue(client, QUEUES.listingChanged, { listingId: after.id, trigger });
  await notify(client, { type: 'book', eventId: after.event_id });
}

export async function createListing(sellerId, input) {
  if (!input.eventId) throw badRequest('eventId is required');
  if (!input.tier) throw badRequest('tier is required');
  const priceCents = requireInt(input.priceCents, 'priceCents', { min: 1 });
  const qty = requireInt(input.qty ?? 1, 'qty', { min: 1, max: 20 });
  return withTransaction(async (client) => {
    const { rows: [row] } = await client.query(
      `INSERT INTO listings (event_id, seller_id, tier, section, seat_label, description,
                             price_cents, qty_total, qty_available, accepts_offers)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9) RETURNING *`,
      [input.eventId, sellerId, input.tier, input.section ?? null, input.seatLabel ?? null,
        input.description ?? null, priceCents, qty, input.acceptsOffers ?? true],
    );
    await afterWrite(client, null, row);
    return listingDto(row);
  });
}

const EDITABLE = {
  priceCents: 'price_cents',
  description: 'description',
  section: 'section',
  seatLabel: 'seat_label',
  acceptsOffers: 'accepts_offers',
};

// Sellers edit price and details; the trigger decides whether the listing keeps its place.
// `withdraw: true` takes it off the book.
export async function updateListing(listingId, sellerId, patch) {
  return withTransaction(async (client) => {
    const { rows: [before] } = await client.query('SELECT * FROM listings WHERE id = $1 FOR UPDATE', [listingId]);
    if (!before) throw notFound('listing');
    if (before.seller_id !== sellerId) throw forbidden('not your listing');
    const sets = [];
    const values = [listingId];
    for (const [key, column] of Object.entries(EDITABLE)) {
      if (patch[key] === undefined) continue;
      const value = key === 'priceCents' ? requireInt(patch[key], 'priceCents', { min: 1 }) : patch[key];
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    }
    if (patch.withdraw) sets.push(`status = 'withdrawn'`);
    if (!sets.length) return listingDto(before);
    const { rows: [after] } = await client.query(
      `UPDATE listings SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      values,
    );
    await afterWrite(client, before, after);
    return listingDto(after);
  });
}
