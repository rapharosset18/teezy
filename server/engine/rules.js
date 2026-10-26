// Pure rules shared by the services: no database, no clock.

// How a ranked list of candidates fills an order of `qty` tickets.
// One seller (default): the best listing that can cover the whole quantity, so seats stay together.
// Split: take tickets in rank order across listings until the quantity is covered.
// Either way the order is all-or-nothing: null when it can't be filled completely.
export function planFills(ranked, qty, allowSplit) {
  if (!allowSplit) {
    const best = ranked.find((l) => l.qtyAvailable >= qty);
    return best ? [{ listing: best, qty }] : null;
  }
  const fills = [];
  let left = qty;
  for (const listing of ranked) {
    if (left === 0) break;
    const take = Math.min(left, listing.qtyAvailable);
    if (take > 0) {
      fills.push({ listing, qty: take });
      left -= take;
    }
  }
  return left === 0 ? fills : null;
}

export function orderTotals(fills, buyerFeeRate) {
  const subtotalCents = fills.reduce((sum, f) => sum + f.listing.priceCents * f.qty, 0);
  const buyerFeeCents = Math.round(subtotalCents * buyerFeeRate);
  return { subtotalCents, buyerFeeCents, totalCents: subtotalCents + buyerFeeCents };
}

// Which listing writes should queue a desired-ticket check.
export function alertTrigger(before, after) {
  if (!after || after.status !== 'active') return null;
  if (!before) return 'created';
  if (after.price_cents < before.price_cents) return 'price_drop';
  return null;
}

export function pctBelow(priceCents, averageCents) {
  return averageCents > 0 ? (averageCents - priceCents) / averageCents : 0;
}

// Price points with a real listing on them right now that sit at least `threshold`
// below the market average.
export function goodDealPoints(distribution, averageCents, threshold) {
  if (!averageCents) return [];
  return distribution
    .filter((p) => pctBelow(p.priceCents, averageCents) >= threshold - 1e-9)
    .map((p) => ({
      priceCents: p.priceCents,
      listings: p.listings,
      pctBelow: Math.round(pctBelow(p.priceCents, averageCents) * 100),
    }));
}
