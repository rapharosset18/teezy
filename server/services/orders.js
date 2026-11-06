// "Buy at $X": match the buyer to the book and open escrow at the listings' prices.
import { config } from '../config.js';
import { withTransaction, query, notify } from '../db.js';
import { enqueue, QUEUES } from '../jobs.js';
import { badRequest, notFound, forbidden, conflict, requireInt } from '../errors.js';
import { CANDIDATE_COLUMNS, rankListings, rankOrderBySql, toCandidate } from '../engine/ranking.js';
import { planFills, orderTotals } from '../engine/rules.js';
import { closeCheckoutForExpiry } from './payments.js';

const LOCK_TIMEOUT = '55P03';

// Listings that could take this order. $1 event, $2 tier (NULL = any), $3 buyer,
// $4 max price per ticket, $5 min tickets per listing.
const ELIGIBLE = `
  FROM listings l
  JOIN users u ON u.id = l.seller_id
  WHERE l.event_id = $1
    AND l.status = 'active'
    AND EXISTS (SELECT 1 FROM events e WHERE e.id = l.event_id AND e.starts_at > now())
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
    listingId: input.listingId || null,
    allowSplit: !!input.allowSplit,
  };
}

// Atomic match. Rows are locked with FOR UPDATE SKIP LOCKED in rank order, so two buyers
// can never be matched to the same seats. If the only seats left are locked by buyers who
// are mid-match, we drop our own locks, wait for theirs, and look again until the deadline.
export async function buyAtPrice(input) {
  const order = parseOrderInput(input);
  const { rows: [buyer] } = await query('SELECT payment_blocked_at FROM users WHERE id = $1', [order.buyerId]);
  if (buyer?.payment_blocked_at) throw forbidden('this account can no longer buy tickets; contact support');
  const minQty = order.allowSplit ? 1 : order.qty;
  const limit = order.allowSplit ? order.qty : 1; // each listing gives at least 1 ticket
  const params = [order.eventId, order.tier, order.buyerId, order.maxPriceCents, minQty];
  // Direct seat purchases must reserve the seat the buyer actually selected.
  if (order.listingId && !/^[0-9a-f-]{36}$/i.test(order.listingId)) throw badRequest('invalid listing id');
  const eligible = ELIGIBLE + (order.listingId ? ' AND l.id = $6::uuid' : '');
  if (order.listingId) params.push(order.listingId);
  const limitParameter = params.length + 1;
  const deadline = Date.now() + config.matchDeadlineMs;

  return withTransaction(async (client) => {
    for (;;) {
      await client.query('SAVEPOINT attempt');
      const { rows } = await client.query(
        `SELECT ${CANDIDATE_COLUMNS} ${eligible}
         ORDER BY ${rankOrderBySql()} LIMIT $${limitParameter}
         FOR UPDATE OF l SKIP LOCKED`,
        [...params, limit],
      );
      const fills = planFills(rankListings(rows.map(toCandidate)), order.qty, order.allowSplit);
      if (fills) return { matched: true, order: await openOrder(client, order, fills) };

      // Release whatever we locked before waiting on anyone else, so waits can't deadlock.
      await client.query('ROLLBACK TO SAVEPOINT attempt');
      const { rows: all } = await client.query(
        `SELECT l.id, l.qty_available ${eligible} ORDER BY ${rankOrderBySql()}`,
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
    `SELECT f.*, l.tier, l.section, l.seat_label, u.display_name AS seller_name, u.rating AS seller_rating,
       EXISTS (SELECT 1 FROM delivery_proofs d WHERE d.fill_id = f.id) AS has_proof
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
      transferReference: f.transfer_reference,
      transferredAt: f.transferred_at,
      confirmedAt: f.confirmed_at,
      autoConfirmed: f.auto_confirmed,
      problemReportedAt: f.problem_reported_at,
      problemReason: f.problem_reason,
      hasProof: f.has_proof,
    })),
  };
}

export async function getOrder(orderId, userId) {
  const order = await loadOrder({ query }, orderId);
  if (!order) throw notFound('order');
  if (order.buyerId !== userId && !order.fills.some((f) => f.sellerId === userId)) throw forbidden('not your order');
  if (order.buyerId !== userId) return {
    id: order.id, eventId: order.eventId, status: order.status, paidAt: order.paidAt,
    fills: order.fills.filter((f) => f.sellerId === userId),
  };
  return order;
}

// Recording a seller's declaration is not proof from the ticketing provider.
// Each seller can only advance their own fill, including on split orders.
export async function recordTransfer(orderId, fillId, sellerId, reference) {
  if (typeof reference !== 'string' || !reference.trim() || reference.trim().length > 200) {
    throw badRequest('enter a transfer reference (1–200 characters)');
  }
  return withTransaction(async (client) => {
    const { rows: [o] } = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
    if (!o) throw notFound('order');
    const { rows: [fill] } = await client.query('SELECT * FROM order_fills WHERE id = $1 AND order_id = $2', [fillId, orderId]);
    if (!fill) throw notFound('ticket');
    if (fill.seller_id !== sellerId) throw forbidden('only the seller can record this transfer');
    if (o.status !== 'paid') throw conflict('not_paid', 'the buyer must pay first');
    if (fill.escrow_status !== 'held') throw conflict('wrong_step', 'this ticket is not waiting for transfer');
    await client.query(`UPDATE order_fills SET escrow_status = 'transferred', transfer_reference = $2,
      transferred_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = $1`, [fillId, reference.trim()]);
    await notify(client, { type: 'order', orderId, userId: o.buyer_id });
    return { id: fillId, status: 'transferred' };
  });
}

export async function confirmTransfer(orderId, fillId, buyerId) {
  return withTransaction(async (client) => {
    const { rows: [o] } = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
    if (!o) throw notFound('order');
    if (o.buyer_id !== buyerId) throw forbidden('only the buyer can confirm receipt');
    if (o.status !== 'paid') throw conflict('not_paid', 'the order has not been paid');
    const { rowCount } = await client.query(`UPDATE order_fills SET escrow_status = 'confirmed',
      confirmed_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE id = $1 AND order_id = $2 AND escrow_status = 'transferred'
      RETURNING seller_id`, [fillId, orderId]);
    if (!rowCount) throw conflict('wrong_step', 'this ticket is not waiting for confirmation');
    await notify(client, { type: 'order', orderId, userId: buyerId });
    return { id: fillId, status: 'confirmed' };
  });
}

const PROOF_MAX_BYTES = 4 * 1024 * 1024; // Stripe limits the total evidence on a dispute
const PROOF_SIGNATURES = {
  'image/png': [0x89, 0x50, 0x4e, 0x47], 'image/jpeg': [0xff, 0xd8, 0xff], 'application/pdf': [0x25, 0x50, 0x44, 0x46],
};

// The seller's transfer confirmation. Without it they aren't covered if the buyer disputes.
export async function saveDeliveryProof(orderId, fillId, sellerId, input = {}) {
  const signature = PROOF_SIGNATURES[input.contentType];
  const file = typeof input.data === 'string' ? Buffer.from(input.data, 'base64') : null;
  if (!signature || !file?.length || !signature.every((byte, i) => file[i] === byte)) throw badRequest('upload a PNG, JPEG or PDF');
  if (file.length > PROOF_MAX_BYTES) throw badRequest('the file must be 4 MB or smaller');
  const filename = String(input.filename || 'transfer-confirmation').slice(0, 200);
  return withTransaction(async (client) => {
    const { rows: [o] } = await client.query('SELECT id FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
    if (!o) throw notFound('order');
    const { rows: [fill] } = await client.query('SELECT * FROM order_fills WHERE id = $1 AND order_id = $2', [fillId, orderId]);
    if (!fill) throw notFound('ticket');
    if (fill.seller_id !== sellerId) throw forbidden('only the seller can add proof');
    if (!['transferred', 'confirmed', 'released'].includes(fill.escrow_status)) throw conflict('wrong_step', 'record the transfer first');
    await client.query(`INSERT INTO delivery_proofs (fill_id, filename, content_type, data) VALUES ($1,$2,$3,$4)
      ON CONFLICT (fill_id) DO UPDATE SET filename=EXCLUDED.filename, content_type=EXCLUDED.content_type, data=EXCLUDED.data, created_at=now()`,
      [fillId, filename, input.contentType, file]);
    return { id: fillId, hasProof: true };
  });
}

// A report keeps the fill out of auto-confirmation, so the seller isn't paid until it's reviewed.
export async function reportProblem(orderId, fillId, buyerId, reason) {
  if (typeof reason !== 'string' || !reason.trim() || reason.trim().length > 500) {
    throw badRequest('describe the problem (1–500 characters)');
  }
  return withTransaction(async (client) => {
    const { rows: [o] } = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
    if (!o) throw notFound('order');
    if (o.buyer_id !== buyerId) throw forbidden('only the buyer can report a problem');
    const { rows: [fill] } = await client.query(`UPDATE order_fills SET problem_reported_at = clock_timestamp(), problem_reason = $3,
      updated_at = clock_timestamp() WHERE id = $1 AND order_id = $2 AND escrow_status = 'transferred'
      AND problem_reported_at IS NULL RETURNING seller_id`, [fillId, orderId, reason.trim()]);
    if (!fill) throw conflict('wrong_step', 'this ticket can no longer be reported');
    await notify(client, { type: 'order', orderId, userId: buyerId });
    await notify(client, { type: 'order', orderId, userId: fill.seller_id });
    return { id: fillId, status: 'transferred', problemReported: true };
  });
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
export async function expireOrder(orderId, stripe) {
  const { rows: [payment] } = await query(`SELECT p.order_id FROM payments p JOIN orders o ON o.id=p.order_id
    WHERE p.order_id=$1 AND o.status='pending_payment' AND o.payment_expires_at<=now()`, [orderId]);
  if (payment) await closeCheckoutForExpiry(orderId, stripe);
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
    await client.query("UPDATE payments SET status='expired',updated_at=now() WHERE order_id=$1 AND status='pending'", [orderId]);
    await notify(client, { type: 'book', eventId: o.event_id });
    return true;
  });
}
