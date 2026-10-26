// Everything the price slider needs, loaded once per page view. The client counts
// "N available" from the distribution as the slider moves, with no request per tick.
import { config } from '../config.js';
import { query } from '../db.js';
import { badRequest, requireInt } from '../errors.js';
import { goodDealPoints } from '../engine/rules.js';

// Median, not mean, so one $0 or $400 outlier in a thin student market can't drag the
// "average" around. Recent paid sales first; with too few, the median asking price.
export async function marketAverage(eventId, tier) {
  const { rows: [sales] } = await query(
    `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY price_cents) AS median, count(*)::int AS n
     FROM completed_sales
     WHERE event_id = $1 AND ($2::text IS NULL OR tier = $2)
       AND sold_at > now() - $3 * interval '1 day'`,
    [eventId, tier, config.salesWindowDays],
  );
  if (sales.n >= config.minSalesForAverage) {
    return { cents: Math.round(sales.median), source: 'sales', sampleSize: sales.n };
  }
  const { rows: [asking] } = await query(
    `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY price_cents) AS median, count(*)::int AS n
     FROM listings
     WHERE event_id = $1 AND ($2::text IS NULL OR tier = $2) AND status = 'active'`,
    [eventId, tier],
  );
  if (asking.n) return { cents: Math.round(asking.median), source: 'listings', sampleSize: asking.n };
  return null;
}

export async function getPriceData({ eventId, tier, buyerId, qty = 1, allowSplit = false }) {
  if (!eventId) throw badRequest('eventId is required');
  tier = tier && tier !== 'any' ? tier : null;
  qty = requireInt(qty, 'qty', { min: 1, max: 10 });
  const minQty = allowSplit ? 1 : qty;

  // Same filter as matching (minus the price cap), so the count matches what "Buy" can get.
  const { rows } = await query(
    `SELECT price_cents, count(*)::int AS listings, sum(qty_available)::int AS tickets
     FROM listings
     WHERE event_id = $1 AND status = 'active' AND ($2::text IS NULL OR tier = $2)
       AND seller_id <> $3 AND qty_available >= $4
     GROUP BY price_cents ORDER BY price_cents`,
    [eventId, tier, buyerId, minQty],
  );
  const distribution = rows.map((r) => ({ priceCents: r.price_cents, listings: r.listings, tickets: r.tickets }));

  const average = await marketAverage(eventId, tier);
  const { rows: [user] } = await query('SELECT max_budget_cents FROM users WHERE id = $1', [buyerId]);
  const { rows: [top] } = await query(
    `SELECT max(price_cents) AS max FROM listings WHERE event_id = $1 AND status = 'active' AND ($2::text IS NULL OR tier = $2)`,
    [eventId, tier],
  );
  const budget = user?.max_budget_cents ?? null;
  const fallbackMax = top.max ? Math.ceil(top.max / 500) * 500 : 10000; // round up to $5

  return {
    eventId,
    tier: tier ?? 'any',
    qty,
    allowSplit,
    distribution,
    marketAverage: average,
    goodDealThreshold: config.goodDealThreshold,
    goodDeals: goodDealPoints(distribution, average?.cents, config.goodDealThreshold),
    slider: { maxCents: budget ?? fallbackMax, budgetSet: budget != null },
    generatedAt: new Date().toISOString(),
  };
}
