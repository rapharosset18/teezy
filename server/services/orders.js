// "Buy at $X": match the buyer to the book and open escrow at the listings' prices.
import { config } from '../config.js';
import { withTransaction, query, notify } from '../db.js';
import { enqueue, QUEUES } from '../jobs.js';
import { badRequest, notFound, forbidden, conflict, requireInt } from '../errors.js';
import { CANDIDATE_COLUMNS, rankListings, rankOrderBySql, toCandidate } from '../engine/ranking.js';
import { planFills, orderTotals } from '../engine/rules.js';

const LOCK_TIMEOUT = '55P03';

// Listings that could take this order. $1 event, $2 tier (NULL = any), $3 buyer,
// $4 max price per ticket, $5 min tickets per listing.
const ELIGIBLE = `
  FROM listings l
  JOIN users u ON u.id = l.seller_id
  WHERE l.event_id = $1
    AND l.status = 'active'
    AND ($2::text IS NULL OR l.tier = $2)
    AND l.seller_id <> $3            -- never match a buyer against their own listing
    AND l.price_cents <= $4
    AND l.qty_available >= $5`;

function parseOrderInput(input) {
  if (!input.buyerId) throw badRequest('buyerId is required');
  if (!input.eventId) throw badRequest('eventId is required');
  return {
    buyerId: input.buyerId,
    eventId: input.eventId,
    tier: input.tier && input.tier !== 'any' ? input.tier : null,
    qty: requireInt(input.qty ?? 1, 'qty', { min: 1, max: 10 }),
    maxPriceCents: requireInt(input.maxPriceCents, 'maxPriceCents', { min: 1 }),
    allowSplit: !!input.allowSplit,
  };
}

// Atomic match. Rows are locked with FOR UPDATE SKIP LOCKED in rank order, so two buyers
// can never be matched to the same seats. If the only seats left are locked by buyers who
// are mid-match, we drop our own locks, wait for theirs, and look again until the deadline.
export async function buyAtPrice(input) {
  const order = parseOrderInput(input);
  const minQty = order.allowSplit ? 1 : order.qty;
  const limit = order.allowSplit ? order.qty : 1; // each listing gives at least 1 ticket
  const params = [order.eventId, order.tier, order.buyerId, order.maxPriceCents, minQty];
  const deadline = Date.now() + config.matchDeadlineMs;

  return withTransaction(async (client) => {
    for (;;) {
      await client.query('SAVEPOINT attempt');
      const { rows } = await client.query(
        `SELECT ${CANDIDATE_COLUMNS} ${ELIGIBLE}
         ORDER BY ${rankOrderBySql()} LIMIT $6
         FOR UPDATE OF l SKIP LOCKED`,
        [...params, limit],
      );
      const fills = planFills(rankListings(rows.map(toCandidate)), order.qty, order.allowSplit);
      if (fills) return { matched: true, order: await openOrder(client, order, fills) };

      // Release whatever we locked before waiting on anyone else, so waits can't deadlock.
      await client.query('ROLLBACK TO SAVEPOINT attempt');
      const { rows: all } = await client.query(
        `SELECT l.id, l.qty_available ${ELIGIBLE} ORDER BY ${rankOrderBySql()}`,
        params,
      );
      const supply = order.allowSplit ? all.reduce((s, r) => s + r.qty_available, 0) : all.length ? order.qty : 0;
      if (supply < order.qty) return { matched: false, reason: 'no_match' };

      // The seats exist but other checkouts hold them. Wait for those to commit or roll back.
      const waitMs = deadline - Date.now();
      if (waitMs <= 0) return { matched: false, reason: 'busy' };
      try {
        await client.query(`SET LOCAL lock_timeout = '${Math.max(1, Math.floor(waitMs))}ms'`);
        await client.query(
          'SELECT 1 FROM listings WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE',
          [all.slice(0, Math.max(limit, 1)).map((r) => r.id)],
        );
      } catch (err) {
        if (err.code !== LOCK_TIMEOUT) throw err;
        await client.query('ROLLBACK TO SAVEPOINT attempt');
        return { matched: false, reason: 'busy' };
      }
      await client.query('ROLLBACK TO SAVEPOINT attempt'); // also undoes the lock_timeout
    }
  });
}

// Takes the seats out of the book and opens escrow, all in the matching transaction.
async function openOrder(client, order, fills) {
  for (const f of fills) {
    await client.query('UPDATE listings SET qty_available = qty_available - $2 WHERE id = $1', [f.listing.id, f.qty]);
  }
  const totals = orderTotals(fills, config.buyerFeeRate);
  const { rows: [row] } = await client.query(
    `INSERT INTO orders (buyer_id, event_id, tier, qty, max_price_cents, allow_split,
                         subtotal_cents, buyer_fee_cents, total_cents, payment_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, clock_timestamp() + $10 * interval '1 millisecond')
     RETURNING id`,
    [order.buyerId, order.eventId, order.tier, order.qty, order.maxPriceCents, order.allowSplit,
      totals.subtotalCents, totals.buyerFeeCents, totals.totalCents, config.paymentWindowMs],
  );
  for (const f of fills) {
    await client.query(
      `INSERT INTO order_fills (order_id, listing_id, seller_id, qty, price_cents) VALUES ($1, $2, $3, $4, $5)`,
      [row.id, f.listing.id, f.listing.sellerId, f.qty, f.listing.priceCents],
    );
  }
  await enqueue(client, QUEUES.orderExpire, { orderId: row.id }, {
    startAfter: Math.ceil(config.paymentWindowMs / 1000),
  });
  await notify(client, { type: 'book', eventId: order.eventId });
  return loadOrder(client, row.id);
}

export async function loadOrder(db, orderId) {
  const { rows: [o] } = await db.query('SELECT * FROM orders WHERE id = $1', [orderId]);
  if (!o) return null;
  const { rows: fills } = await db.query(
    `SELECT f.*, l.tier, l.section, l.seat_label, u.display_name AS seller_name, u.rating AS seller_rating
     FROM order_fills f JOIN listings l ON l.id = f.listing_id JOIN users u ON u.id = f.seller_id
     WHERE f.order_id = $1 ORDER BY f.created_at, f.id`,
    [orderId],
  );
  return {
    id: o.id,
    buyerId: o.buyer_id,
    eventId: o.event_id,
    tier: o.tier,
    qty: o.qty,
    maxPriceCents: o.max_price_cents,
    allowSplit: o.allow_split,
    subtotalCents: o.subtotal_cents,
    buyerFeeCents: o.buyer_fee_cents,
    totalCents: o.total_cents,
    status: o.status,
    paymentExpiresAt: o.payment_expires_at,
    paidAt: o.paid_at,
    fills: fills.map((f) => ({
      id: f.id,
      listingId: f.listing_id,
      sellerId: f.seller_id,
      sellerName: f.seller_name,
      sellerRating: f.seller_rating,
      tier: f.tier,
      section: f.section,
      seatLabel: f.seat_label,
      qty: f.qty,
      priceCents: f.price_cents,
      escrowStatus: f.escrow_status,
    })),
  };
}

export async function getOrder(orderId, userId) {
  const order = await loadOrder({ query }, orderId);
  if (!order) throw notFound('order');
  if (order.buyerId !== userId && !order.fills.some((f) => f.sellerId === userId)) throw forbidden('not your order');
  return order;
}

// Escrow steps, mirroring the app's escrow screen. Each moves every fill of the order
// one step; `from` is the only state the step may start from.
const ESCROW_STEPS = {
  // The card charge is held, not paid out. A payment provider authorization goes here.
  pay: { from: 'awaiting_payment', to: 'held', actor: 'buyer' },
  // Sellers send the tickets through the official transfer. Demo: simulated for them.
  transfer: { from: 'held', to: 'transferred', actor: 'any' },
  // The buyer confirms the tickets arrived in their own account.
  confirm: { from: 'transferred', to: 'confirmed', actor: 'buyer' },
  // Sellers are paid after the event. Production runs this as a job after the event ends.
  release: { from: 'confirmed', to: 'released', actor: 'any' },
};

export async function advanceEscrow(orderId, userId, step) {
  const rule = ESCROW_STEPS[step];
  if (!rule) throw badRequest(`unknown escrow step ${step}`);
  return withTransaction(async (client) => {
    const { rows: [o] } = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
    if (!o) throw notFound('order');
    if (rule.actor === 'buyer' && o.buyer_id !== userId) throw forbidden('only the buyer can do this');
    if (step === 'pay') {
      if (o.status !== 'pending_payment') throw conflict('not_payable', `order is ${o.status}`);
      if (new Date(o.payment_expires_at) <= new Date()) throw conflict('expired', 'the payment window has closed');
      await client.query(`UPDATE orders SET status = 'paid', paid_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = $1`, [orderId]);
    } else if (o.status !== 'paid') {
      throw conflict('not_paid', `order is ${o.status}`);
    }
    const { rowCount } = await client.query(
      `UPDATE order_fills SET escrow_status = $3, updated_at = clock_timestamp()
       WHERE order_id = $1 AND escrow_status = $2`,
      [orderId, rule.from, rule.to],
    );
    if (!rowCount) throw conflict('wrong_step', `nothing is waiting for "${step}"`);
    if (step === 'pay') await notify(client, { type: 'book', eventId: o.event_id }); // feeds the market average
    return loadOrder(client, orderId);
  });
}

// Job: a buyer who doesn't pay in time gives the seats back. Restoring quantity doesn't
// touch the price, so each listing keeps its place in line.
export async function expireOrder(orderId) {
  return withTransaction(async (client) => {
    const { rows: [o] } = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
    if (!o || o.status !== 'pending_payment' || new Date(o.payment_expires_at) > new Date()) return false;
    const { rows: fills } = await client.query(
      `UPDATE order_fills SET escrow_status = 'void', updated_at = clock_timestamp()
       WHERE order_id = $1 AND escrow_status = 'awaiting_payment' RETURNING listing_id, qty`,
      [orderId],
    );
    for (const f of fills) {
      await client.query('UPDATE listings SET qty_available = qty_available + $2 WHERE id = $1', [f.listing_id, f.qty]);
    }
    await client.query(`UPDATE orders SET status = 'expired', updated_at = clock_timestamp() WHERE id = $1`, [orderId]);
    await notify(client, { type: 'book', eventId: o.event_id });
    return true;
  });
}
