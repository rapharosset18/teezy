// Read models for browsing and account history. Public responses never expose email
// addresses, session details, or another buyer's order.
import { query } from '../db.js';
import { badRequest, notFound, requireInt } from '../errors.js';
import { loadOrder } from './orders.js';

export function pagination(input = {}) {
  return {
    limit: requireInt(input.limit ?? 20, 'limit', { min: 1, max: 100 }),
    offset: requireInt(input.offset ?? 0, 'offset', { min: 0, max: 100000 }),
  };
}

function listingDto(row) {
  return {
    id: row.id, eventId: row.event_id, sellerId: row.seller_id,
    sellerName: row.seller_name, sellerRating: row.seller_rating,
    tier: row.tier, section: row.section, seatLabel: row.seat_label,
    description: row.description, priceCents: row.price_cents,
    qtyTotal: row.qty_total, qtyAvailable: row.qty_available,
    acceptsOffers: row.accepts_offers, status: row.status,
    createdAt: row.created_at,
    event: { id: row.event_id, name: row.event_name, venue: row.venue, startsAt: row.starts_at },
  };
}

const LISTING_SELECT = `SELECT l.*, u.display_name AS seller_name, u.rating AS seller_rating,
  e.name AS event_name, e.venue, e.starts_at
  FROM listings l JOIN users u ON u.id = l.seller_id JOIN events e ON e.id = l.event_id`;

export async function getEvent(id) {
  const { rows: [event] } = await query(
    `SELECT e.*, array_remove(array_agg(DISTINCT l.tier), NULL) AS tiers
     FROM events e LEFT JOIN listings l ON l.event_id = e.id
       AND l.status = 'active' AND l.qty_available > 0
     WHERE e.id = $1 GROUP BY e.id`, [id],
  );
  if (!event) throw notFound('event');
  return { id: event.id, name: event.name, venue: event.venue, startsAt: event.starts_at, tiers: event.tiers };
}

export async function listListings(input = {}, sellerId = null) {
  const { limit, offset } = pagination(input);
  const params = [];
  const where = [];
  function filter(sql, value) {
    params.push(value);
    where.push(sql.replace('?', `$${params.length}`));
  }
  if (sellerId) {
    filter('l.seller_id = ?', sellerId);
    if (input.status) {
      if (!['active', 'sold', 'withdrawn'].includes(input.status)) throw badRequest('invalid listing status');
      filter('l.status = ?', input.status);
    }
  } else {
    where.push("l.status = 'active'", 'l.qty_available > 0', 'e.starts_at > now()');
  }
  if (input.eventId) filter('l.event_id = ?', input.eventId);
  if (input.tier && input.tier !== 'any') filter('l.tier = ?', input.tier);
  if (input.qty !== undefined) filter('l.qty_available >= ?', requireInt(input.qty, 'qty', { min: 1, max: 20 }));
  if (input.maxPriceCents !== undefined) filter('l.price_cents <= ?', requireInt(input.maxPriceCents, 'maxPriceCents', { min: 1 }));
  if (input.q) {
    if (typeof input.q !== 'string' || input.q.length > 100) throw badRequest('search must be at most 100 characters');
    // Treat search input literally, including SQL LIKE wildcard characters.
    filter("e.name ILIKE ? ESCAPE '\\'", `%${input.q.replace(/[\\%_]/g, '\\$&')}%`);
  }
  const sorts = {
    price: 'l.price_cents, l.priority_timestamp, l.id',
    newest: 'l.created_at DESC, l.id',
  };
  const sort = input.sort ?? 'price';
  if (!Object.hasOwn(sorts, sort)) throw badRequest('sort must be price or newest');
  params.push(limit + 1, offset);
  const { rows } = await query(
    `${LISTING_SELECT} WHERE ${where.join(' AND ')} ORDER BY ${sorts[sort]}
     LIMIT $${params.length - 1} OFFSET $${params.length}`, params,
  );
  return { items: rows.slice(0, limit).map(listingDto), limit, offset, hasMore: rows.length > limit };
}

export async function getListing(id, userId = null) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw badRequest('invalid listing id');
  const { rows: [row] } = await query(`${LISTING_SELECT} WHERE l.id = $1`, [id]);
  if (!row || (row.seller_id !== userId && (row.status !== 'active' || row.qty_available < 1 || new Date(row.starts_at) <= new Date()))) {
    throw notFound('listing');
  }
  return listingDto(row);
}

export async function listOrders(userId, input = {}, selling = false) {
  const { limit, offset } = pagination(input);
  const { rows } = await query(
    `SELECT o.id FROM orders o WHERE ${selling
      ? 'EXISTS (SELECT 1 FROM order_fills f WHERE f.order_id = o.id AND f.seller_id = $1)'
      : 'o.buyer_id = $1'}
     ORDER BY o.created_at DESC, o.id LIMIT $2 OFFSET $3`, [userId, limit + 1, offset],
  );
  const items = await Promise.all(rows.slice(0, limit).map(async ({ id }) => {
    const order = await loadOrder({ query }, id);
    // An order can include multiple sellers. A seller sees only their own fills,
    // rather than the buyer's full spend or other sellers' transactions.
    if (selling) return {
      id: order.id, eventId: order.eventId, status: order.status, paidAt: order.paidAt,
      fills: order.fills.filter((fill) => fill.sellerId === userId),
    };
    return order;
  }));
  return { items, limit, offset, hasMore: rows.length > limit };
}
