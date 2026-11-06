import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../app.js';
import { config } from '../config.js';
import { query } from '../db.js';
import { buyAtPrice } from '../services/orders.js';
import { resetDb, addListing, order } from './helpers.js';

let app;
const get = (url, user = 'buyer') => app.inject({ method: 'GET', url, headers: { 'x-user-id': user } });

describe('marketplace browsing and account history', () => {
  beforeEach(async () => { await resetDb(); app = buildApp(); });
  afterEach(() => app.close());

  it('returns event details and handles missing events', async () => {
    await addListing({ price: 40 });
    const response = await get('/api/events/game');
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().tiers, ['ga']);
    assert.equal((await get('/api/events/missing')).statusCode, 404);
  });

  it('only browses available upcoming listings, with filters and pagination', async () => {
    const cheap = await addListing({ price: 30, qty: 2 });
    await addListing({ price: 40, qty: 2 });
    await addListing({ price: 50, qty: 1 });
    const withdrawn = await addListing({ price: 10, qty: 2 });
    await query("UPDATE listings SET status = 'withdrawn' WHERE id = $1", [withdrawn.id]);
    const sold = await addListing({ price: 5 });
    await query('UPDATE listings SET qty_available = 0 WHERE id = $1', [sold.id]);
    await addListing({ price: 5, event: 'other' });
    await query("UPDATE events SET starts_at = now() - interval '1 day' WHERE id = 'other'");
    const page = (await get('/api/listings?eventId=game&qty=2&maxPriceCents=4500&limit=1')).json();
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].id, cheap.id);
    assert.equal(page.hasMore, true);
    const next = (await get('/api/listings?eventId=game&qty=2&maxPriceCents=4500&limit=1&offset=1')).json();
    assert.equal(next.items[0].priceCents, 4000);
    assert.equal(next.hasMore, false);
    assert.equal((await get('/api/listings')).json().items.length, 3);
    assert.equal((await get('/api/listings?q=Notre')).json().items.length, 3);
    assert.equal((await get('/api/listings?q=%25')).json().items.length, 0);
  });

  it('keeps withdrawn listings private to their seller', async () => {
    const listing = await addListing({ price: 40 });
    await query("UPDATE listings SET status = 'withdrawn' WHERE id = $1", [listing.id]);
    assert.equal((await get(`/api/listings/${listing.id}`)).statusCode, 404);
    const response = await get(`/api/listings/${listing.id}`, 's1');
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, 'withdrawn');
    assert.equal((await get('/api/me/listings', 's1')).json().items.length, 1);
    assert.equal((await get('/api/me/listings', 's2')).json().items.length, 0);
  });

  it('returns only the current buyer purchases and seller fills', async () => {
    await addListing({ seller: 's1', price: 30 });
    await addListing({ seller: 's2', price: 40 });
    const result = await buyAtPrice(order({ qty: 2, allowSplit: true }));
    assert.equal(result.matched, true);
    const purchases = (await get('/api/me/orders')).json().items;
    assert.equal(purchases.length, 1);
    assert.equal(purchases[0].fills.length, 2);
    assert.equal((await get('/api/me/orders', 'buyer2')).json().items.length, 0);
    const sales = (await get('/api/me/sales', 's1')).json().items;
    assert.equal(sales.length, 1);
    assert.equal(sales[0].fills.length, 1);
    assert.equal(sales[0].fills[0].sellerId, 's1');
    assert.equal(sales[0].totalCents, undefined);
    assert.equal((await get('/api/me/sales', 's3')).json().items.length, 0);
  });

  it('rejects invalid pagination, filters and IDs', async () => {
    for (const url of ['/api/listings?limit=101', '/api/listings?offset=-1', '/api/listings?qty=0',
      '/api/listings?sort=constructor', '/api/listings?maxPriceCents=no', '/api/listings/not-a-uuid',
      '/api/me/listings?status=unknown', '/api/me/orders?limit=0']) {
      assert.equal((await get(url)).statusCode, 400, url);
    }
  });

  it('allows public browsing but requires a session for private history in production', async () => {
    config.isProduction = true;
    try {
      assert.equal((await get('/api/listings')).statusCode, 200);
      for (const url of ['/api/me/listings', '/api/me/orders', '/api/me/sales']) {
        assert.equal((await get(url)).statusCode, 401, url);
      }
    } finally { config.isProduction = false; }
  });
});
