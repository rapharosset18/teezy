import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { query } from '../db.js';
import { rankListings, rankOrderBySql, CANDIDATE_COLUMNS, toCandidate } from '../engine/ranking.js';
import { planFills } from '../engine/rules.js';
import { resetDb, addListing, EVENT } from './helpers.js';

const L = (id, priceCents, priorityUs, qtyAvailable = 1) => ({ id, priceCents, priorityUs: BigInt(priorityUs), qtyAvailable });

describe('rankListings', () => {
  it('ranks by price first, then oldest first, then id', () => {
    const ranked = rankListings([
      L('d', 5000, 300), L('b', 4500, 900), L('c', 5000, 100), L('a', 5000, 100),
    ]);
    assert.deepEqual(ranked.map((l) => l.id), ['b', 'a', 'c', 'd']);
  });

  it('does not mutate its input', () => {
    const input = [L('x', 2, 1), L('y', 1, 1)];
    rankListings(input);
    assert.deepEqual(input.map((l) => l.id), ['x', 'y']);
  });
});

describe('rankListings matches the SQL lock order', () => {
  beforeEach(resetDb);

  it('agrees with ORDER BY on rows with shared prices and timestamps', async () => {
    const sellers = ['s1', 's2', 's3', 's4', 's5'];
    for (let i = 0; i < 40; i++) {
      const priorityAt = new Date(Date.UTC(2026, 9, 1, 12, 0, (i * 7) % 3)).toISOString(); // only 3 distinct times
      await addListing({ seller: sellers[i % 5], price: 40 + (i % 4) * 5, priorityAt });
    }
    const { rows } = await query(
      `SELECT ${CANDIDATE_COLUMNS} FROM listings l JOIN users u ON u.id = l.seller_id
       WHERE l.event_id = $1 ORDER BY ${rankOrderBySql()}`,
      [EVENT],
    );
    const fromSql = rows.map(toCandidate);
    const shuffled = fromSql.slice().sort(() => Math.random() - 0.5);
    assert.deepEqual(rankListings(shuffled).map((l) => l.id), fromSql.map((l) => l.id));
  });
});

describe('planFills', () => {
  const ranked = [L('a', 4000, 1, 1), L('b', 4500, 1, 3), L('c', 5000, 1, 2)];

  it('one seller: the best listing that covers the whole quantity', () => {
    assert.deepEqual(planFills(ranked, 2, false).map((f) => [f.listing.id, f.qty]), [['b', 2]]);
  });

  it('split: fills in priority order across sellers', () => {
    assert.deepEqual(planFills(ranked, 3, true).map((f) => [f.listing.id, f.qty]), [['a', 1], ['b', 2]]);
  });

  it('is all-or-nothing', () => {
    assert.equal(planFills(ranked, 4, false), null);
    assert.equal(planFills(ranked, 7, true), null);
  });
});
