// Order-book ranking: which listing a buyer is matched to first.
//
// Each rule has a JS comparator (used by rankListings) and the SQL ORDER BY term the
// matcher locks rows in. Keeping both on one object means the database and the code
// can't drift apart; test/ranking.test.js checks they agree on real rows.
//
// Candidate shape (see toCandidate): { id, sellerId, priceCents, priorityUs, qtyAvailable,
// sellerRating, ... }. SQL terms can use `l` (listings) and `u` (the seller's users row).

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export const RANK_RULES = [
  // 1. Best price first: the cheapest asking price per ticket.
  { name: 'price', sql: 'l.price_cents ASC', compare: (a, b) => a.priceCents - b.priceCents },

  // Seller rating goes here when we add it. As a tie-breaker between listings at the same
  // price, add:
  //   { name: 'rating', sql: 'u.rating DESC NULLS LAST',
  //     compare: (a, b) => (b.sellerRating ?? -1) - (a.sellerRating ?? -1) },
  // To weight it instead, replace the price rule with one on an "effective price"
  // (e.g. price minus a rating credit) computed the same way in SQL and JS.

  // 2. Time priority: at the same price, the listing that has waited longest wins.
  { name: 'time', sql: 'l.priority_timestamp ASC', compare: (a, b) => cmp(a.priorityUs, b.priorityUs) },

  // 3. Deterministic last resort, so every server ranks identically.
  { name: 'id', sql: 'l.id ASC', compare: (a, b) => cmp(a.id, b.id) },
];

export function compareListings(a, b) {
  for (const rule of RANK_RULES) {
    const r = rule.compare(a, b);
    if (r) return r;
  }
  return 0;
}

export function rankListings(listings) {
  return listings.slice().sort(compareListings);
}

export function rankOrderBySql() {
  return RANK_RULES.map((r) => r.sql).join(', ');
}

// Columns every candidate query selects, mapped by toCandidate.
export const CANDIDATE_COLUMNS = `
  l.id, l.event_id, l.seller_id, l.tier, l.section, l.seat_label, l.price_cents, l.qty_available,
  (extract(epoch FROM l.priority_timestamp) * 1000000)::bigint AS priority_us,
  u.display_name AS seller_name, u.rating AS seller_rating`;

export function toCandidate(row) {
  return {
    id: row.id,
    eventId: row.event_id,
    sellerId: row.seller_id,
    sellerName: row.seller_name,
    sellerRating: row.seller_rating,
    tier: row.tier,
    section: row.section,
    seatLabel: row.seat_label,
    priceCents: row.price_cents,
    qtyAvailable: row.qty_available,
    priorityUs: BigInt(row.priority_us), // microseconds; a JS Date would round ties to the ms
  };
}
