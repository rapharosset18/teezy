import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { query } from '../db.js';
import { resetDemoData, seedDemoData } from '../seed.js';
import { getPriceData } from '../services/priceData.js';

describe('demo seed', () => {
  beforeEach(resetDemoData);

  it('loads the demo book and enough sales for a sales-based market average', async () => {
    await seedDemoData();
    const { rows: [{ n }] } = await query(`SELECT count(*)::int AS n FROM listings WHERE status = 'active'`);
    assert.equal(n, 10);
    const data = await getPriceData({ eventId: 'fb-nd', buyerId: 'mia' });
    assert.equal(data.marketAverage.source, 'sales');
    assert.ok(data.goodDeals.length > 0);
  });
});
