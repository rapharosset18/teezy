import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { query } from '../db.js';
import { getPriceData } from '../services/priceData.js';
import { buyAtPrice, advanceEscrow } from '../services/orders.js';
import { buildApp } from '../app.js';
import { resetDb, addListing, order, cents, EVENT } from './helpers.js';

const data = (overrides = {}) => getPriceData({ eventId: EVENT, buyerId: 'buyer', ...overrides });

async function sell(price, buyerId) {
  await addListing({ seller: 's5', price });
  const { order: o } = await buyAtPrice(order({ buyerId, maxPriceCents: cents(price) }));
  await advanceEscrow(o.id, buyerId, 'pay');
}

describe('price data for the slider', () => {
  beforeEach(resetDb);

  it('counts listings per price point, excluding the buyer’s own and listings too small', async () => {
    await addListing({ seller: 's1', price: 40 });
    await addListing({ seller: 's2', price: 40, qty: 2 });
    await addListing({ seller: 's3', price: 55, qty: 2 });
    await addListing({ seller: 'buyer', price: 30 });
    assert.deepEqual((await data()).distribution, [
      { priceCents: 4000, listings: 2, tickets: 3 },
      { priceCents: 5500, listings: 1, tickets: 2 },
    ]);
    assert.deepEqual((await data({ qty: 2 })).distribution.map((p) => p.priceCents), [4000, 5500]);
    assert.equal((await data({ qty: 2 })).distribution[0].listings, 1);
  });

  it('uses the median of active asking prices when there are too few sales', async () => {
    for (const p of [40, 50, 60, 200]) await addListing({ seller: 's1', price: p });
    const avg = (await data()).marketAverage;
    assert.deepEqual(avg, { cents: 5500, source: 'listings', sampleSize: 4 });
  });

  it('switches to the median of recent sales once there are enough', async () => {
    for (const [i, p] of [60, 62, 64, 66, 300].entries()) await sell(p, `b${i}`);
    await addListing({ seller: 's1', price: 10 });
    assert.deepEqual((await data()).marketAverage, { cents: 6400, source: 'sales', sampleSize: 5 });
  });

  it('flags only real listings at least 15% below the market average', async () => {
    for (const p of [50, 60, 60, 60, 70]) await addListing({ seller: 's1', price: p }); // median 60
    const d = await data();
    assert.equal(d.goodDealThreshold, 0.15);
    assert.deepEqual(d.goodDeals, [{ priceCents: 5000, listings: 1, pctBelow: 17 }]);
  });

  it('caps the slider at the saved budget, or the highest listing rounded up to $5', async () => {
    await addListing({ seller: 's1', price: 72 });
    assert.deepEqual((await data()).slider, { maxCents: 7500, budgetSet: false });
    await query(`UPDATE users SET max_budget_cents = 9000 WHERE id = 'buyer'`);
    assert.deepEqual((await data()).slider, { maxCents: 9000, budgetSet: true });
  });
});

describe('HTTP API', () => {
  beforeEach(resetDb);

  it('POST /api/orders matches, or offers a desired-ticket alert when nothing fits', async () => {
    const app = buildApp();
    const headers = { 'x-user-id': 'buyer' };
    const miss = await app.inject({ method: 'POST', url: '/api/orders', headers, payload: { eventId: EVENT, qty: 1, maxPriceCents: 3000 } });
    assert.equal(miss.statusCode, 200);
    assert.deepEqual(miss.json().suggestedAlert, { eventId: EVENT, tier: 'any', qty: 1, maxPriceCents: 3000 });

    await addListing({ seller: 's1', price: 25 });
    const hit = await app.inject({ method: 'POST', url: '/api/orders', headers, payload: { eventId: EVENT, qty: 1, maxPriceCents: 3000 } });
    assert.equal(hit.statusCode, 201);
    assert.equal(hit.json().order.subtotalCents, 2500);

    const bad = await app.inject({ method: 'POST', url: '/api/orders', headers, payload: { eventId: EVENT, qty: 0, maxPriceCents: 3000 } });
    assert.equal(bad.statusCode, 400);
    await app.close();
  });
});
