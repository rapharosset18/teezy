// In-browser stand-in for the Teezy API, used only by the artifact build (artifact/build.js).
// The published artifact can't reach a server, so this answers the page's /api/* requests
// and its live stream from memory, following the same rules as server/services/*:
// the order book (cheapest first, then oldest), escrow steps, the market average,
// desired-ticket alerts and dev sign-in. State resets when the page reloads.
(function () {
  'use strict';

  var BUYER_FEE_RATE = 0.05;
  var PAYMENT_WINDOW_MS = 5 * 60 * 1000;
  var GOOD_DEAL_THRESHOLD = 0.15;
  var SALES_WINDOW_DAYS = 30;
  var MIN_SALES_FOR_AVERAGE = 5;
  var ALERT_COOLDOWN_MS = 30 * 60 * 1000;
  var MIN = 60 * 1000, DAY = 24 * 60 * MIN;

  /* ---------------- demo data (same as server/seed.js) ---------------- */
  var users = {};
  [
    ['mia', 'Mia Chen', 5.0],
    ['priya', 'Priya S.', 5.0], ['taylor', 'Taylor B.', 4.9], ['sam', 'Sam K.', 4.9],
    ['riley', 'Riley P.', 4.4], ['chris', 'Chris T.', 4.7], ['ana', 'Ana R.', 5.0],
    ['grant', 'Grant P.', 4.5], ['noah', 'Noah W.', 4.8], ['lena', 'Lena V.', 4.9], ['bella', 'Bella M.', 4.6],
    ['jordan-m', 'Jordan M.', 4.8], ['casey-l', 'Casey L.', 4.9], ['avery-d', 'Avery D.', 4.7]
  ].forEach(function (u) { users[u[0]] = { id: u[0], displayName: u[1], rating: u[2], email: null, emailVerified: false, maxBudgetCents: null }; });

  var events = [
    { id: 'fb-nd', name: 'USC vs Oregon', venue: 'Coliseum', startsAt: '2026-11-21T17:00:00-08:00' },
    { id: 'sigchi-formal', name: 'Sigma Chi Formal', venue: 'Off-campus venue', startsAt: '2026-11-08T21:00:00-08:00' },
    { id: 'aka-social', name: 'AKA Fall Social', venue: 'Off-campus venue', startsAt: '2026-10-31T21:00:00-07:00' }
  ];
  var eventById = {};
  events.forEach(function (e) { eventById[e.id] = e; });

  var seq = 0;
  function newId(prefix) { seq++; return prefix + '-' + Date.now().toString(36) + '-' + seq; }

  var now = Date.now();
  var listings = [
    ['priya', 'fb-nd', 'ga', '108', 'Sec 108 · Row 5 · GA pair', 65, 2, 1440],
    ['taylor', 'fb-nd', 'ga', '110', 'Sec 110 · Row 22 · 2 seats', 55, 2, 300],
    ['sam', 'fb-nd', 'ga', '106', 'Sec 106 · Row 18 · Seat 2', 50, 1, 120],
    ['riley', 'fb-nd', 'student', '25', 'Sec 25 · Row 12 · 2 seats', 38, 2, 45],
    ['chris', 'fb-nd', 'student', '27', 'Sec 27 · Row 40 · Seat 8', 48, 1, 600],
    ['ana', 'fb-nd', 'reserved', '115', 'Sec 115 · Row 3 · 4 seats', 80, 4, 900],
    ['grant', 'sigchi-formal', 'entry', null, 'Sigma Chi Formal · wristband ×1', 40, 1, 400],
    ['noah', 'sigchi-formal', 'entry', null, 'Sigma Chi Formal · wristband ×2', 35, 2, 200],
    ['lena', 'aka-social', 'entry', null, 'AKA Fall Social · wristband ×2', 30, 2, 500],
    ['bella', 'aka-social', 'entry', null, 'AKA Fall Social · wristband ×1', 28, 1, 90]
  ].map(function (r) {
    var t = now - r[7] * MIN;
    return { id: newId('l'), sellerId: r[0], eventId: r[1], tier: r[2], section: r[3], seatLabel: r[4], description: null,
      priceCents: r[5] * 100, qtyTotal: r[6], qtyAvailable: r[6], acceptsOffers: true, status: 'active', priority: t, createdAt: t };
  });

  // Completed sales feed the market average: [event, tier, price per ticket, days ago].
  var sales = [
    ['fb-nd', 'ga', 55, 2], ['fb-nd', 'ga', 58, 3], ['fb-nd', 'ga', 60, 5], ['fb-nd', 'ga', 62, 6], ['fb-nd', 'ga', 65, 9], ['fb-nd', 'ga', 70, 12],
    ['fb-nd', 'student', 42, 1], ['fb-nd', 'student', 45, 4], ['fb-nd', 'student', 48, 7], ['fb-nd', 'student', 50, 8], ['fb-nd', 'student', 52, 15],
    ['fb-nd', 'reserved', 78, 3], ['fb-nd', 'reserved', 85, 10], ['fb-nd', 'reserved', 90, 20],
    ['aka-social', 'entry', 32, 2]
  ].map(function (s) { return { eventId: s[0], tier: s[1], priceCents: s[2] * 100, soldAt: now - s[3] * DAY }; });

  var orders = {};
  var desired = [];
  var desiredNotified = {}; // desiredId|listingId -> true
  var notifications = [];
  var loginCodes = {};      // email -> code
  var caller = { id: 'mia', signedIn: false };

  /* ---------------- helpers ---------------- */
  function HttpError(status, error, message) { this.status = status; this.body = { error: error, message: message }; }
  var badRequest = function (m) { return new HttpError(400, 'bad_request', m); };
  var notFound = function (what) { return new HttpError(404, 'not_found', what + ' not found'); };
  var conflict = function (code, m) { return new HttpError(409, code, m); };
  function requireInt(v, name, min, max) {
    var n = Number(v);
    if (!Number.isInteger(n) || n < min || (max != null && n > max)) throw badRequest(name + ' must be a whole number' + (max != null ? ' from ' + min + ' to ' + max : ' of at least ' + min));
    return n;
  }
  function tierOrNull(t) { return t && t !== 'any' ? t : null; }
  function median(xs) {
    var s = xs.slice().sort(function (a, b) { return a - b; }), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function money(cents) { return '$' + (cents % 100 ? (cents / 100).toFixed(2) : String(cents / 100)); }
  function iso(t) { return t == null ? null : new Date(t).toISOString(); }

  /* ---------------- live stream (stands in for /api/stream) ---------------- */
  var streams = [];
  function emit(event) {
    setTimeout(function () {
      streams.forEach(function (s) { s._deliver(event); });
    }, 0);
  }
  function FakeEventSource(url) {
    this.url = url;
    this.readyState = 1;
    this.onmessage = null;
    this.onerror = null;
    this.onopen = null;
    this._listeners = {};
    streams.push(this);
    var self = this;
    setTimeout(function () { if (self.onopen) self.onopen({}); }, 0);
  }
  FakeEventSource.prototype.addEventListener = function (type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); };
  FakeEventSource.prototype.removeEventListener = function (type, fn) {
    this._listeners[type] = (this._listeners[type] || []).filter(function (f) { return f !== fn; });
  };
  FakeEventSource.prototype.close = function () {
    this.readyState = 2;
    var self = this;
    streams = streams.filter(function (s) { return s !== self; });
  };
  FakeEventSource.prototype._deliver = function (event) {
    var msg = { data: JSON.stringify(event) };
    if (this.onmessage) this.onmessage(msg);
    (this._listeners.message || []).forEach(function (fn) { fn(msg); });
  };
  window.EventSource = FakeEventSource;

  /* ---------------- order book ---------------- */
  function rank(a, b) { return (a.priceCents - b.priceCents) || (a.priority - b.priority) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); }

  function listingDto(l) {
    return { id: l.id, eventId: l.eventId, sellerId: l.sellerId, tier: l.tier, section: l.section, seatLabel: l.seatLabel,
      description: l.description, priceCents: l.priceCents, qtyTotal: l.qtyTotal, qtyAvailable: l.qtyAvailable,
      acceptsOffers: l.acceptsOffers, status: l.status, priorityTimestamp: iso(l.priority) };
  }

  function marketAverage(eventId, tier) {
    var since = Date.now() - SALES_WINDOW_DAYS * DAY;
    var recent = sales.filter(function (s) { return s.eventId === eventId && (!tier || s.tier === tier) && s.soldAt > since; });
    if (recent.length >= MIN_SALES_FOR_AVERAGE) {
      return { cents: Math.round(median(recent.map(function (s) { return s.priceCents; }))), source: 'sales', sampleSize: recent.length };
    }
    var asking = listings.filter(function (l) { return l.eventId === eventId && (!tier || l.tier === tier) && l.status === 'active'; });
    if (asking.length) return { cents: Math.round(median(asking.map(function (l) { return l.priceCents; }))), source: 'listings', sampleSize: asking.length };
    return null;
  }

  function priceData(eventId, q) {
    var tier = tierOrNull(q.get('tier'));
    var qty = requireInt(q.get('qty') || 1, 'qty', 1, 10);
    var allowSplit = ['true', '1'].indexOf(q.get('split')) !== -1;
    var minQty = allowSplit ? 1 : qty;
    var byPrice = {};
    listings.forEach(function (l) {
      if (l.eventId !== eventId || l.status !== 'active' || (tier && l.tier !== tier) || l.sellerId === caller.id || l.qtyAvailable < minQty) return;
      var p = byPrice[l.priceCents] = byPrice[l.priceCents] || { priceCents: l.priceCents, listings: 0, tickets: 0 };
      p.listings++;
      p.tickets += l.qtyAvailable;
    });
    var distribution = Object.keys(byPrice).map(function (k) { return byPrice[k]; }).sort(function (a, b) { return a.priceCents - b.priceCents; });
    var average = marketAverage(eventId, tier);
    var top = 0;
    listings.forEach(function (l) { if (l.eventId === eventId && l.status === 'active' && (!tier || l.tier === tier)) top = Math.max(top, l.priceCents); });
    var budget = users[caller.id] ? users[caller.id].maxBudgetCents : null;
    var goodDeals = !average ? [] : distribution
      .filter(function (p) { return (average.cents - p.priceCents) / average.cents >= GOOD_DEAL_THRESHOLD - 1e-9; })
      .map(function (p) { return { priceCents: p.priceCents, listings: p.listings, pctBelow: Math.round((average.cents - p.priceCents) / average.cents * 100) }; });
    return {
      eventId: eventId, tier: tier || 'any', qty: qty, allowSplit: allowSplit, distribution: distribution,
      marketAverage: average, goodDealThreshold: GOOD_DEAL_THRESHOLD, goodDeals: goodDeals,
      slider: { maxCents: budget != null ? budget : (top ? Math.ceil(top / 500) * 500 : 10000), budgetSet: budget != null },
      generatedAt: new Date().toISOString()
    };
  }

  function orderDto(o) {
    return {
      id: o.id, buyerId: o.buyerId, eventId: o.eventId, tier: o.tier, qty: o.qty, maxPriceCents: o.maxPriceCents,
      allowSplit: o.allowSplit, subtotalCents: o.subtotalCents, buyerFeeCents: o.buyerFeeCents, totalCents: o.totalCents,
      status: o.status, paymentExpiresAt: iso(o.paymentExpiresAt), paidAt: iso(o.paidAt),
      fills: o.fills.map(function (f) {
        var l = f.listing, seller = users[l.sellerId] || {};
        return { id: f.id, listingId: l.id, sellerId: l.sellerId, sellerName: seller.displayName, sellerRating: seller.rating,
          tier: l.tier, section: l.section, seatLabel: l.seatLabel, qty: f.qty, priceCents: f.priceCents, escrowStatus: f.escrowStatus };
      })
    };
  }

  // Same as server/engine/rules.js planFills: one seller covering the whole quantity by
  // default, or tickets in rank order across sellers when splitting is allowed.
  function planFills(ranked, qty, allowSplit) {
    if (!allowSplit) {
      var best = ranked.filter(function (l) { return l.qtyAvailable >= qty; })[0];
      return best ? [{ listing: best, qty: qty }] : null;
    }
    var fills = [], left = qty;
    ranked.forEach(function (l) {
      if (!left) return;
      var take = Math.min(left, l.qtyAvailable);
      if (take > 0) { fills.push({ listing: l, qty: take }); left -= take; }
    });
    return left === 0 ? fills : null;
  }

  function buyAtPrice(b) {
    if (!b.eventId) throw badRequest('eventId is required');
    var tier = tierOrNull(b.tier);
    var qty = requireInt(b.qty == null ? 1 : b.qty, 'qty', 1, 10);
    var max = requireInt(b.maxPriceCents, 'maxPriceCents', 1);
    var allowSplit = !!b.allowSplit;
    var eligible = listings.filter(function (l) {
      return l.eventId === b.eventId && l.status === 'active' && (!tier || l.tier === tier) &&
        l.sellerId !== caller.id && l.priceCents <= max && l.qtyAvailable >= (allowSplit ? 1 : qty);
    }).sort(rank);
    var fills = planFills(eligible, qty, allowSplit);
    if (!fills) {
      return { matched: false, reason: 'no_match', suggestedAlert: { eventId: b.eventId, tier: b.tier || 'any', qty: qty, maxPriceCents: max } };
    }
    fills.forEach(function (f) { f.listing.qtyAvailable -= f.qty; });
    var subtotal = fills.reduce(function (s, f) { return s + f.listing.priceCents * f.qty; }, 0);
    var fee = Math.round(subtotal * BUYER_FEE_RATE);
    var o = {
      id: newId('o'), buyerId: caller.id, eventId: b.eventId, tier: tier, qty: qty, maxPriceCents: max, allowSplit: allowSplit,
      subtotalCents: subtotal, buyerFeeCents: fee, totalCents: subtotal + fee, status: 'pending_payment',
      paymentExpiresAt: Date.now() + PAYMENT_WINDOW_MS, paidAt: null,
      fills: fills.map(function (f) { return { id: newId('f'), listing: f.listing, qty: f.qty, priceCents: f.listing.priceCents, escrowStatus: 'awaiting_payment' }; })
    };
    orders[o.id] = o;
    setTimeout(function () { expireOrder(o); }, PAYMENT_WINDOW_MS + 50);
    emit({ type: 'book', eventId: o.eventId });
    return { matched: true, order: orderDto(o) };
  }

  // A buyer who doesn't pay in time gives the seats back, keeping each listing's place in line.
  function expireOrder(o) {
    if (o.status !== 'pending_payment') return;
    o.fills.forEach(function (f) {
      if (f.escrowStatus === 'awaiting_payment') { f.escrowStatus = 'void'; f.listing.qtyAvailable += f.qty; }
    });
    o.status = 'expired';
    emit({ type: 'book', eventId: o.eventId });
  }

  var ESCROW_STEPS = {
    pay: { from: 'awaiting_payment', to: 'held' },
    transfer: { from: 'held', to: 'transferred' },
    confirm: { from: 'transferred', to: 'confirmed' },
    release: { from: 'confirmed', to: 'released' }
  };

  function advanceEscrow(id, step) {
    var o = orders[id], rule = ESCROW_STEPS[step];
    if (!rule) throw notFound('route');
    if (!o) throw notFound('order');
    if (step === 'pay') {
      if (o.status !== 'pending_payment') throw conflict('not_payable', 'order is ' + o.status);
      if (o.paymentExpiresAt <= Date.now()) throw conflict('expired', 'the payment window has closed');
      o.status = 'paid';
      o.paidAt = Date.now();
      o.fills.forEach(function (f) { sales.push({ eventId: o.eventId, tier: f.listing.tier, priceCents: f.priceCents, soldAt: o.paidAt }); });
    } else if (o.status !== 'paid') {
      throw conflict('not_paid', 'order is ' + o.status);
    }
    var moved = 0;
    o.fills.forEach(function (f) { if (f.escrowStatus === rule.from) { f.escrowStatus = rule.to; moved++; } });
    if (!moved) throw conflict('wrong_step', 'nothing is waiting for "' + step + '"');
    if (step === 'pay') emit({ type: 'book', eventId: o.eventId });
    return orderDto(o);
  }

  /* ---------------- selling ---------------- */
  function afterWrite(before, after) {
    var trigger = after.status !== 'active' ? null : !before ? 'created' : after.priceCents < before.priceCents ? 'price_drop' : null;
    if (trigger) setTimeout(function () { checkDesiredForListing(after, trigger); }, 600); // the server runs this as a background job
    emit({ type: 'book', eventId: after.eventId });
  }

  function createListing(sellerId, input) {
    if (!input.eventId) throw badRequest('eventId is required');
    if (!input.tier) throw badRequest('tier is required');
    var price = requireInt(input.priceCents, 'priceCents', 1);
    var qty = requireInt(input.qty == null ? 1 : input.qty, 'qty', 1, 20);
    var t = Date.now();
    var l = { id: newId('l'), sellerId: sellerId, eventId: input.eventId, tier: input.tier, section: input.section || null,
      seatLabel: input.seatLabel || null, description: input.description || null, priceCents: price, qtyTotal: qty, qtyAvailable: qty,
      acceptsOffers: input.acceptsOffers !== false, status: 'active', priority: t, createdAt: t };
    listings.push(l);
    afterWrite(null, l);
    return listingDto(l);
  }

  function updateListing(l, patch) {
    var before = Object.assign({}, l);
    if (patch.priceCents !== undefined) l.priceCents = requireInt(patch.priceCents, 'priceCents', 1);
    ['description', 'section', 'seatLabel', 'acceptsOffers'].forEach(function (k) { if (patch[k] !== undefined) l[k] = patch[k]; });
    if (patch.withdraw) l.status = 'withdrawn';
    afterWrite(before, l);
    return listingDto(l);
  }

  /* ---------------- desired tickets and alerts ---------------- */
  function desiredDto(d) {
    return { id: d.id, userId: d.userId, eventId: d.eventId, tier: d.tier || 'any', qty: d.qty, maxPriceCents: d.maxPriceCents,
      paused: d.paused, lastNotifiedAt: iso(d.lastNotifiedAt), createdAt: iso(d.createdAt) };
  }
  function findDesired(id) {
    var d = desired.filter(function (x) { return x.id === id && x.userId === caller.id; })[0];
    if (!d) throw notFound('desired ticket');
    return d;
  }
  function availableNow(d) {
    return listings.filter(function (l) {
      return l.eventId === d.eventId && l.status === 'active' && (!d.tier || l.tier === d.tier) &&
        l.sellerId !== d.userId && l.priceCents <= d.maxPriceCents && l.qtyAvailable >= d.qty;
    }).length;
  }

  function checkDesiredForListing(l, trigger) {
    desired.forEach(function (d) {
      if (d.paused || l.status !== 'active' || d.eventId !== l.eventId || (d.tier && d.tier !== l.tier) ||
          l.priceCents > d.maxPriceCents || l.qtyAvailable < d.qty || d.userId === l.sellerId) return;
      if (d.lastNotifiedAt && Date.now() - d.lastNotifiedAt < ALERT_COOLDOWN_MS) return;
      var key = d.id + '|' + l.id;
      if (desiredNotified[key]) return;
      desiredNotified[key] = true;
      d.lastNotifiedAt = Date.now();
      var price = money(l.priceCents), ev = eventById[d.eventId], seller = users[l.sellerId];
      var n = {
        id: newId('n'), userId: d.userId, kind: 'desired_ticket',
        title: trigger === 'price_drop' ? 'Your desired ticket dropped to ' + price : 'Your desired ticket hit ' + price,
        body: ev.name + ' · ' + seller.displayName + ' · under your ' + money(d.maxPriceCents) + ' max. Tap to buy.',
        deepLink: '/?event=' + d.eventId + '&tier=' + (d.tier || 'any') + '&qty=' + d.qty + '&price=' + d.maxPriceCents / 100,
        data: { desiredTicketId: d.id, listingId: l.id, trigger: trigger, eventId: d.eventId, tier: d.tier || 'any', qty: d.qty,
          maxPriceCents: d.maxPriceCents, priceCents: l.priceCents },
        createdAt: new Date().toISOString(), readAt: null
      };
      notifications.push(n);
      if (d.userId === caller.id) emit({ type: 'notification', notification: n });
    });
  }

  // Demo only (server/services/devSim.js): another seller moves the market toward an alert.
  var SIM_SELLERS = ['jordan-m', 'casey-l', 'avery-d'], simNext = 0;
  function marketMove(desiredId) {
    var d = findDesired(desiredId);
    var close = listings.filter(function (l) {
      return l.eventId === d.eventId && l.status === 'active' && (!d.tier || l.tier === d.tier) && l.sellerId !== caller.id &&
        l.qtyAvailable >= d.qty && l.priceCents > d.maxPriceCents && l.priceCents <= d.maxPriceCents * 1.4;
    }).sort(function (a, b) { return a.priceCents - b.priceCents; })[0];
    if (close) return { action: 'price_drop', listing: updateListing(close, { priceCents: d.maxPriceCents }) };
    var counts = {};
    listings.forEach(function (l) { if (l.eventId === d.eventId) counts[l.tier] = (counts[l.tier] || 0) + 1; });
    var tier = d.tier || Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; })[0] || 'ga';
    var seller = SIM_SELLERS[simNext++ % SIM_SELLERS.length];
    return { action: 'created', listing: createListing(seller, { eventId: d.eventId, tier: tier, qty: d.qty, priceCents: d.maxPriceCents,
      seatLabel: d.qty + ' seat' + (d.qty > 1 ? 's' : '') + ' together' }) };
  }

  /* ---------------- sign-in ---------------- */
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  function normalizeEmail(e) {
    e = String(e == null ? '' : e).trim().toLowerCase();
    if (!EMAIL_RE.test(e) || e.length > 254) throw badRequest('enter a valid email address');
    return e;
  }
  function displayNameFrom(email) {
    var local = email.split('@')[0].replace(/[._-]+/g, ' ').trim();
    return local ? local.replace(/\b\w/g, function (c) { return c.toUpperCase(); }) : 'New member';
  }

  /* ---------------- routes ---------------- */
  var routes = [
    ['POST', /^\/api\/auth\/email\/start$/, function (m, body) {
      var email = normalizeEmail(body.email);
      var code = String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
      loginCodes[email] = code;
      return { sent: true, email: email, devCode: code }; // no email in the demo; the page fills the code in
    }],
    ['POST', /^\/api\/auth\/email\/verify$/, function (m, body) {
      var email = normalizeEmail(body.email);
      if (!loginCodes[email] || String(body.code || '').trim() !== loginCodes[email]) {
        throw new HttpError(400, 'invalid_code', 'That code is wrong or has expired. Request a new one.');
      }
      delete loginCodes[email];
      var user = Object.keys(users).map(function (k) { return users[k]; }).filter(function (u) { return u.email === email; })[0];
      if (!user) {
        user = { id: 'u_' + newId('x'), displayName: displayNameFrom(email), email: email, emailVerified: true, rating: null, maxBudgetCents: null };
        users[user.id] = user;
      }
      caller = { id: user.id, signedIn: true };
      return { user: { id: user.id, displayName: user.displayName, email: user.email } };
    }],
    ['POST', /^\/api\/auth\/logout$/, function () { caller = { id: 'mia', signedIn: false }; return null; }],
    ['GET', /^\/api\/me$/, function () {
      var u = users[caller.id];
      return { id: u.id, displayName: u.displayName, email: u.email, emailVerified: !!u.emailVerified, signedIn: caller.signedIn,
        rating: u.rating, maxBudgetCents: u.maxBudgetCents };
    }],
    ['PATCH', /^\/api\/me$/, function (m, body) {
      var u = users[caller.id];
      u.maxBudgetCents = body.maxBudgetCents == null ? null : requireInt(body.maxBudgetCents, 'maxBudgetCents', 1);
      return { id: u.id, maxBudgetCents: u.maxBudgetCents };
    }],
    ['GET', /^\/api\/events$/, function () {
      return events.map(function (e) {
        var tiers = [];
        listings.forEach(function (l) { if (l.eventId === e.id && l.status === 'active' && tiers.indexOf(l.tier) === -1) tiers.push(l.tier); });
        return { id: e.id, name: e.name, venue: e.venue, startsAt: e.startsAt, tiers: tiers };
      });
    }],
    ['GET', /^\/api\/events\/([^/]+)\/price-data$/, function (m, body, q) { return priceData(decodeURIComponent(m[1]), q); }],
    ['POST', /^\/api\/orders$/, function (m, body) { return buyAtPrice(body); }, function (r) { return r.matched ? 201 : 200; }],
    ['GET', /^\/api\/orders\/([^/]+)$/, function (m) { if (!orders[m[1]]) throw notFound('order'); return orderDto(orders[m[1]]); }],
    ['POST', /^\/api\/orders\/([^/]+)\/([a-z]+)$/, function (m) { return advanceEscrow(m[1], m[2]); }],
    ['POST', /^\/api\/listings$/, function (m, body) { return createListing(caller.id, body); }, 201],
    ['PATCH', /^\/api\/listings\/([^/]+)$/, function (m, body) {
      var l = listings.filter(function (x) { return x.id === m[1]; })[0];
      if (!l) throw notFound('listing');
      if (l.sellerId !== caller.id) throw new HttpError(403, 'forbidden', 'not your listing');
      return updateListing(l, body);
    }],
    ['GET', /^\/api\/desired-tickets$/, function () {
      return desired.filter(function (d) { return d.userId === caller.id; }).map(desiredDto);
    }],
    ['POST', /^\/api\/desired-tickets$/, function (m, body) {
      if (!body.eventId) throw badRequest('eventId is required');
      var d = { id: newId('d'), userId: caller.id, eventId: body.eventId, tier: tierOrNull(body.tier),
        qty: requireInt(body.qty == null ? 1 : body.qty, 'qty', 1, 10), maxPriceCents: requireInt(body.maxPriceCents, 'maxPriceCents', 1),
        paused: false, lastNotifiedAt: null, createdAt: Date.now() };
      desired.push(d);
      var out = desiredDto(d);
      out.availableNow = availableNow(d);
      return out;
    }, 201],
    ['PATCH', /^\/api\/desired-tickets\/([^/]+)$/, function (m, body) {
      var d = findDesired(m[1]), any = false;
      if (body.paused !== undefined) { d.paused = !!body.paused; any = true; }
      if (body.maxPriceCents !== undefined) { d.maxPriceCents = requireInt(body.maxPriceCents, 'maxPriceCents', 1); any = true; }
      if (body.qty !== undefined) { d.qty = requireInt(body.qty, 'qty', 1, 10); any = true; }
      if (body.tier !== undefined) { d.tier = tierOrNull(body.tier); any = true; }
      if (!any) throw badRequest('nothing to update');
      return desiredDto(d);
    }],
    ['DELETE', /^\/api\/desired-tickets\/([^/]+)$/, function (m) {
      var d = findDesired(m[1]);
      desired = desired.filter(function (x) { return x !== d; });
      return null;
    }],
    ['POST', /^\/api\/push-tokens$/, function () { return null; }],
    ['GET', /^\/api\/notifications$/, function () {
      return notifications.filter(function (n) { return n.userId === caller.id; }).slice().reverse();
    }],
    ['POST', /^\/api\/dev\/market-move$/, function (m, body) { return marketMove(body.desiredTicketId); }]
  ];

  function respond(status, body) {
    return Promise.resolve(new Response(body == null ? null : JSON.stringify(body), {
      status: body == null && status < 300 ? 204 : status,
      headers: { 'content-type': 'application/json' }
    }));
  }

  var realFetch = window.fetch ? window.fetch.bind(window) : null;
  window.fetch = function (input, init) {
    var url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (url.pathname.indexOf('/api/') !== 0) return realFetch(input, init);
    var method = ((init && init.method) || 'GET').toUpperCase();
    var body = {};
    try { body = init && init.body ? JSON.parse(init.body) : {}; } catch (e) { return respond(400, { error: 'bad_request', message: 'invalid JSON' }); }
    for (var i = 0; i < routes.length; i++) {
      var r = routes[i];
      if (r[0] !== method) continue;
      var m = url.pathname.match(r[1]);
      if (!m) continue;
      try {
        var result = r[2](m, body || {}, url.searchParams);
        var status = typeof r[3] === 'function' ? r[3](result) : (r[3] || 200);
        // A short delay so loading states show as they would against a real server.
        return new Promise(function (resolve) { setTimeout(function () { resolve(respond(status, result)); }, 120); });
      } catch (err) {
        if (err instanceof HttpError) return respond(err.status, err.body);
        return respond(500, { error: 'internal', message: 'something went wrong' });
      }
    }
    return respond(404, { error: 'not_found', message: 'route not found' });
  };
})();
