import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { query } from '../db.js';
import { config } from '../config.js';
import { alertTrigger } from '../engine/rules.js';
import { createListing, updateListing } from '../services/listings.js';
import { createDesired, updateDesired, checkDesiredForListing } from '../services/desiredTickets.js';
import { startWorker } from '../worker.js';
import { resetDb, addListing, cents, EVENT } from './helpers.js';

const want = (overrides = {}) => createDesired('buyer', { eventId: EVENT, tier: 'any', qty: 1, maxPriceCents: cents(50), ...overrides });

async function queued(name) {
  const { rows } = await query('SELECT data FROM pgboss.job WHERE name = $1 ORDER BY created_on', [name]);
  return rows.map((r) => r.data);
}

describe('alertTrigger', () => {
  it('fires on create and on price drops only', () => {
    const l = { status: 'active', price_cents: 5000 };
    assert.equal(alertTrigger(null, l), 'created');
    assert.equal(alertTrigger(l, { ...l, price_cents: 4500 }), 'price_drop');
    assert.equal(alertTrigger(l, { ...l, price_cents: 5500 }), null);
    assert.equal(alertTrigger(l, { ...l, description: 'x' }), null);
    assert.equal(alertTrigger(null, { ...l, status: 'withdrawn' }), null);
  });
});

describe('listing writes queue the check instead of running it', () => {
  beforeEach(resetDb);

  it('enqueues on create and price drop, not on a price rise or other edits', async () => {
    const l = await createListing('s1', { eventId: EVENT, tier: 'ga', priceCents: cents(60) });
    await updateListing(l.id, 's1', { priceCents: cents(65) });
    await updateListing(l.id, 's1', { description: 'Aisle' });
    await updateListing(l.id, 's1', { priceCents: cents(55) });
    const jobs = await queued('listing-changed');
    assert.deepEqual(jobs, [{ listingId: l.id, trigger: 'created' }, { listingId: l.id, trigger: 'price_drop' }]);
    const { rows: [{ n }] } = await query('SELECT count(*)::int AS n FROM notifications');
    assert.equal(n, 0, 'nothing was sent inside the request');
  });
});

describe('checkDesiredForListing', () => {
  let savedCooldown;
  beforeEach(async () => { await resetDb(); savedCooldown = config.alertCooldownMs; });
  afterEach(() => { config.alertCooldownMs = savedCooldown; });

  it('notifies a matching entry with a deep link pre-set to the entry price', async () => {
    await want({ tier: 'ga', qty: 2 });
    const l = await addListing({ seller: 's1', price: 45, qty: 2, tier: 'ga' });
    const sent = await checkDesiredForListing({ listingId: l.id, trigger: 'created' });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].userId, 'buyer');
    assert.match(sent[0].title, /\$45/);
    const link = new URL(sent[0].deepLink, 'http://x');
    assert.deepEqual(Object.fromEntries(link.searchParams), { event: EVENT, tier: 'ga', qty: '2', price: '50' });
  });

  it('skips entries that do not match', async () => {
    await want({ maxPriceCents: cents(40) });                 // too cheap
    await want({ tier: 'student' });                          // wrong tier
    await want({ qty: 3 });                                   // not enough tickets
    await createDesired('buyer', { eventId: 'other', maxPriceCents: cents(99) }); // wrong event
    await createDesired('s1', { eventId: EVENT, maxPriceCents: cents(99) });      // the seller themself
    const paused = await want();
    await updateDesired('buyer', paused.id, { paused: true });
    const l = await addListing({ seller: 's1', price: 45, qty: 2, tier: 'ga' });
    assert.equal((await checkDesiredForListing({ listingId: l.id, trigger: 'created' })).length, 0);
  });

  it('sends at most one alert per entry per listing', async () => {
    config.alertCooldownMs = 0;
    await want();
    const l = await addListing({ price: 45 });
    assert.equal((await checkDesiredForListing({ listingId: l.id, trigger: 'created' })).length, 1);
    assert.equal((await checkDesiredForListing({ listingId: l.id, trigger: 'price_drop' })).length, 0);
  });

  it('respects the cooldown across listings, then alerts again after it', async () => {
    config.alertCooldownMs = 60 * 60 * 1000;
    const entry = await want();
    const a = await addListing({ seller: 's1', price: 45 });
    const b = await addListing({ seller: 's2', price: 44 });
    assert.equal((await checkDesiredForListing({ listingId: a.id, trigger: 'created' })).length, 1);
    assert.equal((await checkDesiredForListing({ listingId: b.id, trigger: 'created' })).length, 0);
    await query(`UPDATE desired_tickets SET last_notified_at = now() - interval '2 hours' WHERE id = $1`, [entry.id]);
    assert.equal((await checkDesiredForListing({ listingId: b.id, trigger: 'created' })).length, 1);
  });

  it('runs end to end through the queue and worker', async () => {
    await startWorker({ pollingIntervalSeconds: 0.5 });
    await want();
    await createListing('s1', { eventId: EVENT, tier: 'ga', priceCents: cents(48) });
    let rows = [];
    for (let i = 0; i < 40 && !rows.length; i++) {
      await new Promise((r) => setTimeout(r, 250));
      ({ rows } = await query(`SELECT * FROM notifications WHERE user_id = 'buyer'`));
    }
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'desired_ticket');
  });
});
