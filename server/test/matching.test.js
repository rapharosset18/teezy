import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { query } from '../db.js';
import { config } from '../config.js';
import { buyAtPrice, advanceEscrow, expireOrder } from '../services/orders.js';
import { updateListing } from '../services/listings.js';
import { resetDb, addListing, getListing, order, cents } from './helpers.js';

const matchedListing = (res) => res.order.fills[0].listingId;

describe('price priority', () => {
  beforeEach(resetDb);

  it('matches the lowest-priced listing at or below the buyer price', async () => {
    await addListing({ seller: 's1', price: 60 });
    const best = await addListing({ seller: 's2', price: 50 });
    await addListing({ seller: 's3', price: 55 });
    const res = await buyAtPrice(order({ maxPriceCents: cents(70) }));
    assert.equal(res.matched, true);
    assert.equal(matchedListing(res), best.id);
  });

  it('charges the listing price, not the buyer max, plus the 5% fee', async () => {
    await addListing({ price: 95 });
    const res = await buyAtPrice(order({ maxPriceCents: cents(100) }));
    assert.equal(res.order.subtotalCents, cents(95));
    assert.equal(res.order.buyerFeeCents, Math.round(cents(95) * 0.05));
    assert.equal(res.order.totalCents, cents(95) + Math.round(cents(95) * 0.05));
    assert.equal(res.order.fills[0].priceCents, cents(95));
  });

  it('does not match listings above the buyer price', async () => {
    await addListing({ price: 50 });
    const res = await buyAtPrice(order({ maxPriceCents: cents(49) }));
    assert.deepEqual(res, { matched: false, reason: 'no_match' });
  });

  it('only matches the requested event and tier; "any" matches every tier', async () => {
    await addListing({ seller: 's1', price: 30, tier: 'student' });
    await addListing({ seller: 's2', price: 20, event: 'other' });
    const ga = await addListing({ seller: 's3', price: 45, tier: 'ga' });
    assert.equal(matchedListing(await buyAtPrice(order({ tier: 'ga' }))), ga.id);
    const any = await buyAtPrice(order({ buyerId: 'buyer2', tier: 'any' }));
    assert.equal(any.order.fills[0].tier, 'student');
  });
});

describe('time priority', () => {
  beforeEach(resetDb);

  it('at the same price, the oldest listing wins', async () => {
    await addListing({ seller: 's1', price: 50, listedSecondsAgo: 60 });
    const oldest = await addListing({ seller: 's2', price: 50, listedSecondsAgo: 600 });
    await addListing({ seller: 's3', price: 50, listedSecondsAgo: 5 });
    assert.equal(matchedListing(await buyAtPrice(order())), oldest.id);
  });

  it('a price change resets the place in line, even back to the same price', async () => {
    const a = await addListing({ seller: 's1', price: 50, listedSecondsAgo: 600 });
    const b = await addListing({ seller: 's2', price: 50, listedSecondsAgo: 60 });
    await updateListing(a.id, 's1', { priceCents: cents(55) });
    await updateListing(a.id, 's1', { priceCents: cents(50) });
    const after = await getListing(a.id);
    assert.ok(after.priority_timestamp > b.priority_timestamp, 'a re-queued behind b');
    assert.equal(matchedListing(await buyAtPrice(order())), b.id);
  });

  it('edits that do not touch the price keep the place in line', async () => {
    const a = await addListing({ seller: 's1', price: 50, listedSecondsAgo: 600 });
    await addListing({ seller: 's2', price: 50, listedSecondsAgo: 60 });
    await updateListing(a.id, 's1', { description: 'Aisle seats', seatLabel: 'Row 5' });
    const after = await getListing(a.id);
    assert.equal(after.priority_timestamp.getTime(), a.priority_timestamp.getTime());
    assert.equal(matchedListing(await buyAtPrice(order())), a.id);
  });

  it('the database ignores attempts to set priority_timestamp directly', async () => {
    const a = await addListing({ price: 50, listedSecondsAgo: 600 });
    await query(`UPDATE listings SET priority_timestamp = now() - interval '10 years' WHERE id = $1`, [a.id]);
    assert.equal((await getListing(a.id)).priority_timestamp.getTime(), a.priority_timestamp.getTime());
  });
});

describe('quantity and partial fills', () => {
  beforeEach(resetDb);

  it('by default fills from one seller, skipping cheaper listings that are too small', async () => {
    await addListing({ seller: 's1', price: 40, qty: 1 });
    const pair = await addListing({ seller: 's2', price: 45, qty: 2 });
    const res = await buyAtPrice(order({ qty: 2 }));
    assert.deepEqual(res.order.fills.map((f) => [f.listingId, f.qty]), [[pair.id, 2]]);
  });

  it('takes part of a bigger listing and leaves the rest in place, same priority', async () => {
    const four = await addListing({ seller: 's1', price: 80, qty: 4, listedSecondsAgo: 600 });
    await buyAtPrice(order({ qty: 3 }));
    const after = await getListing(four.id);
    assert.equal(after.qty_available, 1);
    assert.equal(after.status, 'active');
    assert.equal(after.priority_timestamp.getTime(), four.priority_timestamp.getTime());
  });

  it('marks a listing sold when its last ticket goes', async () => {
    const l = await addListing({ price: 50, qty: 2 });
    await buyAtPrice(order({ qty: 2 }));
    assert.equal((await getListing(l.id)).status, 'sold');
  });

  it('with split allowed, fills across sellers in priority order', async () => {
    const cheap = await addListing({ seller: 's1', price: 40, qty: 1 });
    const mid = await addListing({ seller: 's2', price: 45, qty: 1, listedSecondsAgo: 100 });
    await addListing({ seller: 's3', price: 45, qty: 1, listedSecondsAgo: 10 });
    const res = await buyAtPrice(order({ qty: 2, allowSplit: true }));
    assert.deepEqual(res.order.fills.map((f) => [f.listingId, f.qty]), [[cheap.id, 1], [mid.id, 1]]);
    assert.equal(res.order.subtotalCents, cents(85));
  });

  it('is all-or-nothing: no partial order when supply is short', async () => {
    const l = await addListing({ price: 40, qty: 1 });
    assert.equal((await buyAtPrice(order({ qty: 2, allowSplit: true }))).matched, false);
    assert.equal((await getListing(l.id)).qty_available, 1);
  });
});

describe('self-match prevention', () => {
  beforeEach(resetDb);

  it('skips the buyer’s own listing even when it is the best price', async () => {
    await addListing({ seller: 'buyer', price: 30 });
    const other = await addListing({ seller: 's1', price: 50 });
    assert.equal(matchedListing(await buyAtPrice(order())), other.id);
  });

  it('returns no match when only the buyer’s own listings fit', async () => {
    await addListing({ seller: 'buyer', price: 30 });
    assert.equal((await buyAtPrice(order())).matched, false);
  });
});

describe('concurrent buyers', () => {
  beforeEach(resetDb);

  const buyers = (n) => Array.from({ length: n }, (_, i) => `b${i}`);

  it('never matches two buyers to the same last ticket', async () => {
    const l = await addListing({ price: 50, qty: 1 });
    const results = await Promise.all(buyers(15).map((b) => buyAtPrice(order({ buyerId: b }))));
    assert.equal(results.filter((r) => r.matched).length, 1);
    assert.ok(results.filter((r) => !r.matched).every((r) => r.reason === 'no_match'));
    assert.equal((await getListing(l.id)).qty_available, 0);
    const { rows: [{ n }] } = await query('SELECT count(*)::int AS n FROM order_fills');
    assert.equal(n, 1);
  });

  it('sells every seat of a multi-seat listing exactly once', async () => {
    const l = await addListing({ price: 50, qty: 5 });
    const results = await Promise.all(buyers(12).map((b) => buyAtPrice(order({ buyerId: b }))));
    assert.equal(results.filter((r) => r.matched).length, 5);
    assert.equal((await getListing(l.id)).qty_available, 0);
  });

  it('spreads buyers over the book without overselling any listing', async () => {
    const book = [
      await addListing({ seller: 's1', price: 40, qty: 2 }),
      await addListing({ seller: 's2', price: 45, qty: 3 }),
      await addListing({ seller: 's3', price: 45, qty: 1 }),
      await addListing({ seller: 's4', price: 60, qty: 2 }),
    ];
    const results = await Promise.all(buyers(20).map((b) => buyAtPrice(order({ buyerId: b }))));
    assert.equal(results.filter((r) => r.matched).length, 8);
    const { rows } = await query(
      `SELECT l.id, l.qty_total, l.qty_available, coalesce(sum(f.qty), 0)::int AS sold
       FROM listings l LEFT JOIN order_fills f ON f.listing_id = l.id GROUP BY l.id`,
    );
    for (const r of rows) {
      assert.equal(r.qty_available, 0);
      assert.equal(r.sold, r.qty_total, 'fills add up to exactly the seats listed');
    }
    assert.equal(book.length, rows.length);
  });

  it('handles concurrent split orders without deadlocks or overselling', async () => {
    await addListing({ seller: 's1', price: 40, qty: 2 });
    await addListing({ seller: 's2', price: 45, qty: 2 });
    const results = await Promise.all(buyers(6).map((b) => buyAtPrice(order({ buyerId: b, qty: 2, allowSplit: true }))));
    assert.equal(results.filter((r) => r.matched).length, 2);
    const { rows: [{ n }] } = await query('SELECT coalesce(sum(qty), 0)::int AS n FROM order_fills');
    assert.equal(n, 4);
  });
});

describe('escrow handoff', () => {
  beforeEach(resetDb);

  it('opens escrow awaiting payment, then pay holds the money', async () => {
    await addListing({ seller: 's1', price: 50 });
    const { order: o } = await buyAtPrice(order());
    assert.equal(o.status, 'pending_payment');
    assert.equal(o.fills[0].escrowStatus, 'awaiting_payment');
    const paid = await advanceEscrow(o.id, 'buyer', 'pay');
    assert.equal(paid.status, 'paid');
    assert.equal(paid.fills[0].escrowStatus, 'held');
    await assert.rejects(advanceEscrow(o.id, 'buyer', 'pay'), { code: 'not_payable' });
    await assert.rejects(advanceEscrow(o.id, 'buyer', 'confirm'), { code: 'wrong_step' });
    for (const step of ['transfer', 'confirm', 'release']) await advanceEscrow(o.id, 'buyer', step);
    const { rows: [f] } = await query('SELECT escrow_status FROM order_fills WHERE order_id = $1', [o.id]);
    assert.equal(f.escrow_status, 'released');
  });

  it('only the buyer can pay', async () => {
    await addListing({ seller: 's1', price: 50 });
    const { order: o } = await buyAtPrice(order());
    await assert.rejects(advanceEscrow(o.id, 's1', 'pay'), { code: 'forbidden' });
  });

  it('an unpaid order expires and gives the seats back without losing their place', async () => {
    const saved = config.paymentWindowMs;
    config.paymentWindowMs = 0;
    try {
      const l = await addListing({ seller: 's1', price: 50, qty: 2, listedSecondsAgo: 600 });
      const { order: o } = await buyAtPrice(order({ qty: 2 }));
      assert.equal((await getListing(l.id)).status, 'sold');
      assert.equal(await expireOrder(o.id), true);
      const after = await getListing(l.id);
      assert.equal(after.qty_available, 2);
      assert.equal(after.status, 'active');
      assert.equal(after.priority_timestamp.getTime(), l.priority_timestamp.getTime());
      await assert.rejects(advanceEscrow(o.id, 'buyer', 'pay'), { code: 'not_payable' });
    } finally {
      config.paymentWindowMs = saved;
    }
  });

  it('expiry leaves paid orders alone', async () => {
    await addListing({ seller: 's1', price: 50 });
    const { order: o } = await buyAtPrice(order());
    await advanceEscrow(o.id, 'buyer', 'pay');
    assert.equal(await expireOrder(o.id), false);
  });
});
