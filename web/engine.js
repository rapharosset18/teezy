/*
 * Teezy client helpers: pure functions, no DOM, no network, no clock.
 *
 * Matching, the order book, holds and desired-ticket alerts run on the server
 * (server/services/orders.js, server/services/desiredTickets.js). What's left here is
 * what the page computes locally:
 *   - the price slider's live count and good-deal badge, from the distribution the
 *     server sends once per page view (no request per slider tick);
 *   - the market average behind the feed's deal badges on the demo's mock listings.
 *
 * Shapes
 *   Point  { price, count }                       one price on the slider's distribution
 *   Deal   { price, count, pctBelow }             a good-deal price point
 *   Sale   { eventId, tier, pricePerTicket, soldAt }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TeezyEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Mirrors server/config.js for the mock feed's badges.
  var DEFAULTS = {
    goodDealThreshold: 0.15,
    salesWindowMs: 30 * 24 * 60 * 60 * 1000,
    minSalesForAverage: 5
  };

  function tierMatches(wanted, tier) {
    return !wanted || wanted === 'any' || wanted === tier;
  }

  function median(values) {
    if (!values.length) return null;
    var s = values.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  // Same rule as the server: median of recent sales, else median asking price.
  function marketAverage(sales, listings, eventId, tier, now) {
    var recent = sales.filter(function (s) {
      return s.eventId === eventId && tierMatches(tier, s.tier) &&
        s.soldAt <= now && now - s.soldAt <= DEFAULTS.salesWindowMs;
    }).map(function (s) { return s.pricePerTicket; });
    if (recent.length >= DEFAULTS.minSalesForAverage) {
      return { value: median(recent), source: 'sales', sampleSize: recent.length };
    }
    var asking = listings.filter(function (l) {
      return l.status === 'active' && l.eventId === eventId && tierMatches(tier, l.tier) && l.qtyAvailable > 0;
    }).map(function (l) { return l.pricePerTicket; });
    if (asking.length) return { value: median(asking), source: 'listings', sampleSize: asking.length };
    return null;
  }

  function pctBelow(price, average) {
    return average > 0 ? (average - price) / average : 0;
  }

  // "N available" under the slider.
  function countAtOrBelow(dist, price) {
    var n = 0;
    for (var i = 0; i < dist.length && dist[i].price <= price; i++) n += dist[i].count;
    return n;
  }

  // The deepest discount the slider has passed.
  function bestDealAtOrBelow(points, price) {
    var best = null;
    points.forEach(function (p) {
      if (p.price <= price && (!best || p.pctBelow > best.pctBelow)) best = p;
    });
    return best;
  }

  // Negotiated deals in the demo still settle locally.
  function recordSale(listing, qty) {
    var left = listing.qtyAvailable - qty;
    if (!(qty >= 1) || left < 0) throw new Error('cannot sell ' + qty + ' of ' + listing.qtyAvailable + ' on ' + listing.id);
    var out = {}, k;
    for (k in listing) out[k] = listing[k];
    out.qtyAvailable = left;
    out.status = left === 0 ? 'sold' : listing.status;
    return out;
  }

  return {
    DEFAULTS: DEFAULTS,
    median: median,
    marketAverage: marketAverage,
    pctBelow: pctBelow,
    countAtOrBelow: countAtOrBelow,
    bestDealAtOrBelow: bestDealAtOrBelow,
    recordSale: recordSale
  };
});
