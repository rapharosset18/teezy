import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../app.js';
import { config } from '../config.js';
import { query } from '../db.js';
import { resetDb, addListing, order } from './helpers.js';
import { buyAtPrice, advanceEscrow } from '../services/orders.js';

let app;
const post = (path, user, payload = {}) => app.inject({ method: 'POST', url: path, headers: { 'x-user-id': user }, payload });

describe('ticket delivery', () => {
  beforeEach(async () => { await resetDb(); app = buildApp(); });
  afterEach(() => app.close());

  it('reserves exactly the selected listing instead of a cheaper seat elsewhere', async () => {
    await addListing({ price: 20 });
    const selected = await addListing({ seller: 's2', price: 50 });
    const { order: purchase } = await buyAtPrice(order({ listingId: selected.id }));
    assert.equal(purchase.fills[0].listingId, selected.id);
  });

  it('persists seller transfer evidence and buyer confirmation through the HTTP API', async () => {
    await addListing({ price: 40 });
    const { order: purchase } = await buyAtPrice(order());
    const base = `/api/orders/${purchase.id}/fills/${purchase.fills[0].id}`;
    assert.equal((await post(base + '/transfer', 's1', { reference: 'TEST-123' })).statusCode, 409);
    await post(`/api/orders/${purchase.id}/pay`, 'buyer');
    assert.equal((await post(base + '/confirm', 'buyer')).statusCode, 409);
    assert.equal((await post(base + '/transfer', 'buyer', { reference: 'TEST-123' })).statusCode, 403);
    assert.equal((await post(base + '/transfer', 's2', { reference: 'TEST-123' })).statusCode, 403);
    assert.equal((await post(base + '/transfer', 's1', { reference: ' ' })).statusCode, 400);
    assert.equal((await post(base + '/transfer', 's1', { reference: 'TEST-123' })).statusCode, 200);
    assert.equal((await post(base + '/transfer', 's1', { reference: 'again' })).statusCode, 409);
    assert.equal((await post(base + '/confirm', 's1')).statusCode, 403);
    assert.equal((await post(base + '/confirm', 'buyer')).statusCode, 200);
    assert.equal((await post(base + '/confirm', 'buyer')).statusCode, 409);
    const reloaded = await app.inject({ method: 'GET', url: `/api/orders/${purchase.id}`, headers: { 'x-user-id': 'buyer' } });
    const fill = reloaded.json().fills[0];
    assert.equal(fill.escrowStatus, 'confirmed');
    assert.equal(fill.transferReference, 'TEST-123');
    assert.ok(fill.transferredAt);
    assert.ok(fill.confirmedAt);
  });

  it('seller actions and history remain isolated on split orders', async () => {
    await addListing({ seller: 's1', price: 30 });
    await addListing({ seller: 's2', price: 40 });
    const { order: purchase } = await buyAtPrice(order({ qty: 2, allowSplit: true }));
    await advanceEscrow(purchase.id, 'buyer', 'pay');
    const own = purchase.fills.find((f) => f.sellerId === 's1');
    await post(`/api/orders/${purchase.id}/fills/${own.id}/transfer`, 's1', { reference: 'ONE-ONLY' });
    const { rows } = await query('SELECT seller_id, escrow_status FROM order_fills WHERE order_id = $1 ORDER BY seller_id', [purchase.id]);
    assert.deepEqual(rows.map((r) => [r.seller_id, r.escrow_status]), [['s1', 'transferred'], ['s2', 'held']]);
    const detail = await app.inject({ method: 'GET', url: `/api/orders/${purchase.id}`, headers: { 'x-user-id': 's1' } });
    assert.equal(detail.json().fills.length, 1);
    assert.equal(detail.json().totalCents, undefined);
  });

  it('provides practice accounts using session cookies and blocks old buyer transfer shortcuts', async () => {
    const fixture = (await post('/api/dev/transfer-fixture', 'buyer')).json();
    const login = await post('/api/dev/test-session', 'buyer', { role: 'buyer' });
    assert.equal(login.statusCode, 200);
    const cookie = login.headers['set-cookie'].split(';')[0];
    const result = await app.inject({ method: 'POST', url: '/api/orders', headers: { cookie }, payload: {
      eventId: fixture.eventId, listingId: fixture.listingId, tier: 'ga', qty: 1, maxPriceCents: 1000,
    } });
    assert.equal(result.statusCode, 201);
    assert.equal(result.json().order.buyerId, 'transfer-test-buyer');
    assert.equal((await post(`/api/orders/${result.json().order.id}/transfer`, 'buyer')).statusCode, 400);
    assert.equal((await post('/api/dev/test-session', 'buyer', { role: 'admin' })).statusCode, 400);
  });

  it('removes the practice tools and simulated payment API in production', async () => {
    await addListing({ price: 40 });
    const { order: purchase } = await buyAtPrice(order());
    config.isProduction = true;
    const production = buildApp();
    try {
      for (const path of ['/api/dev/transfer-fixture', '/api/dev/test-session']) {
        assert.equal((await production.inject({ method: 'POST', url: path, payload: {} })).statusCode, 404);
      }
      assert.equal((await production.inject({ method: 'GET', url: '/transfer-test.html' })).statusCode, 404);
      assert.equal((await production.inject({ method: 'POST', url: `/api/orders/${purchase.id}/pay` })).statusCode, 400);
      assert.equal((await production.inject({ method: 'GET', url: '/api/runtime' })).json().demoPayments, false);
    } finally { await production.close(); config.isProduction = false; }
  });
});
