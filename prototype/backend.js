/* Connect the Swoosh screens to the API without changing the prototype's styling. */
window.installTeezyBackend = function (ui) {
  'use strict';
  var S = ui.S, EV = ui.EV, V = ui.V, O = ui.O, A = ui.A;
  var esc = ui.esc, money = ui.money, render = ui.render;
  var me = null, runtime = {}, loading = true, failure = '', busy = false, generation = 0;
  var orders = [], sales = [], notifications = [], desired = [], catalog = [];
  var sellerPayments = { ready: false }, transactions = { payments: [], transfers: [] };
  var login = { email: '', code: '', sent: false, hint: '' }, stream;
  var originalHome = V.home, originalSearch = V.search, originalEvent = V.event, originalSeatsheet = O.seatsheet;
  var originalEvents = Object.values(EV).map(function (e) { return Object.assign({}, e); });
  ['offers', 'tickets', 'selling', 'sales', 'requests', 'threads', 'activity', 'parking'].forEach(function (key) { S[key] = []; });
  S.watch = {}; S.drops = {}; S.teams = {}; S.ready = 0; S.settings.payout = 'Not connected';
  S.where.when = 'This month';
  ui.UPCOMING.splice(0); ui.FRIEND_PLANS.splice(0);
  Object.keys(ui.TEAMS).forEach(function (key) { delete ui.TEAMS[key]; });

  async function api(method, path, body) {
    var response;
    try {
      response = await fetch(path, { method: method, credentials: 'same-origin',
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (_) { throw new Error('Cannot reach Teezy. Check your connection and try again.'); }
    if (response.status === 204) return null;
    var data;
    try { data = await response.json(); } catch (_) { throw new Error('The Teezy backend is unavailable. Start the app server and retry.'); }
    if (!response.ok) { var error = new Error(data.message || 'Something went wrong. Try again.'); error.status = response.status; throw error; }
    return data;
  }
  async function pages(path) {
    var items = [], offset = 0, page;
    do { page = await api('GET', path + '?limit=100&offset=' + offset); items = items.concat(page.items); offset += 100; } while (page.hasMore);
    return items;
  }
  function button(label, action, attrs, secondary) {
    return '<button class="btn ' + (secondary ? 'btn-ghost' : 'btn-primary') + '" data-act="' + action + '" ' + (attrs || '') + (busy ? ' disabled' : '') + '>' + esc(label) + '</button>';
  }
  function heading(title) {
    return '<div class="hd line"><div class="between"><h1 class="title">' + esc(title) + '</h1>' + button('Account', 'drawer', '', true) + '</div></div>';
  }
  function note(text) { return '<p class="sub" role="status">' + esc(text) + '</p>'; }
  function empty(text) { return '<p class="empty">' + esc(text) + '</p>'; }
  function shell(title, content) { return heading(title) + '<div class="body">' + content + '</div>'; }
  function panel(title, content) {
    return '<button class="scrim" data-act="close" aria-label="Close"></button><div class="sheet" role="dialog" aria-label="' + esc(title) + '"><span class="grab"></span><h2 class="title" style="font-size:1.4rem">' + esc(title) + '</h2>' + content + '</div>';
  }
  function input(label, name, type, value, extra) {
    return '<label class="stack" style="gap:6px">' + esc(label) + '<input class="field" name="' + name + '" type="' + (type || 'text') + '" value="' + esc(value || '') + '" ' + (extra || '') + ' required></label>';
  }
  function submit(label) { return '<button class="btn btn-primary btn-full" type="submit"' + (busy ? ' disabled' : '') + '>' + esc(busy ? 'Working…' : label) + '</button>'; }
  function proofField() {
    return '<label class="stack" style="gap:6px">Proof of transfer (PNG, JPEG or PDF, up to 4 MB)<input class="field" name="proof" type="file" accept="image/png,image/jpeg,application/pdf"></label>' +
      note('Upload the transfer confirmation showing the buyer’s email and the time. If the buyer files a chargeback, Teezy covers you only if you uploaded proof.');
  }
  function readProof(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve({ filename: file.name, contentType: file.type, data: String(reader.result).split(',')[1] }); };
      reader.onerror = function () { reject(new Error('That file could not be read.')); };
      reader.readAsDataURL(file);
    });
  }
  function signedIn() { if (me) return true; ui.sheet({ k: 'login' }); return false; }
  function eventName(id) { return EV[id] ? EV[id].name : 'Event'; }
  function paymentNote() {
    if (runtime.stripePayments) return note(runtime.paymentMode === 'test' ? 'Stripe test mode · no real money moves.' : 'Secure card checkout with Stripe.');
    return runtime.demoPayments ? note('Test checkout · no money is charged. Transfer status is saved.') : note('Payments are awaiting Stripe account setup.');
  }
  function demoOrder(order) { return runtime.demoPayments || runtime.transferTesting && order.buyerId === 'transfer-test-buyer'; }
  function paymentFor(id) { return transactions.payments.find(function (p) { return p.order_id === id; }); }
  function adaptEvent(e) {
    var d = new Date(e.startsAt), reference = originalEvents.find(function (old) { return old.name === e.name; }) || {};
    var prices = catalog.filter(function (l) { return l.eventId === e.id; }).map(function (l) { return l.priceCents / 100; });
    EV[e.id] = Object.assign({}, reference, { name: e.name, short: e.name.replace(' vs ', '\nvs '),
      venue: e.venue || 'Venue to be announced', cat: /USC vs|volleyball|basketball/i.test(e.name) ? 'Sports' : 'Parties',
      startsAt: e.startsAt, past: d < new Date(), day: d.getDate(), dow: d.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase(),
      date: d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }),
      time: d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
      dist: reference.dist || 0, color: reference.color || '#2F4A3C', range: prices.length ? [Math.min.apply(null, prices), Math.max.apply(null, prices)] : [10, 100] });
  }
  async function refresh() {
    var current = ++generation;
    var profile = await api('GET', '/api/me').catch(function (err) { if (err.status === 401) return null; throw err; });
    var user = profile && profile.signedIn ? profile : null;
    var data = await Promise.all([api('GET', '/api/runtime'), api('GET', '/api/events'), pages('/api/listings'),
      user ? pages('/api/me/listings') : [], user ? pages('/api/me/orders') : [], user ? pages('/api/me/sales') : [],
      user ? api('GET', '/api/notifications') : [], user ? api('GET', '/api/desired-tickets') : []]);
    if (current !== generation) return;
    me = user; runtime = data[0]; catalog = data[2]; orders = data[4]; sales = data[5]; notifications = data[6]; desired = data[7];
    var financial = await Promise.all([user ? api('GET', '/api/me/payments') : { payments: [], transfers: [] },
      user && runtime.stripePayments ? api('GET', '/api/me/seller-payments').catch(function () { return { ready: false, unavailable: true }; }) : { ready: false }]);
    if (current !== generation) return;
    transactions = financial[0]; sellerPayments = financial[1];
    data[1].forEach(adaptEvent);
    ui.UPCOMING.splice(0); data[1].filter(function (e) { return !EV[e.id].past; }).forEach(function (e) { ui.UPCOMING.push(e.id); });
    S.listings = catalog.filter(function (l) { return !me || l.sellerId !== me.id; }).map(function (l) {
      return { id: l.id, ev: l.eventId, sec: l.section || 'General admission', row: '', seats: l.qtyAvailable,
        seller: l.sellerName, price: l.priceCents / 100, tier: l.tier, tag: { ga: 'GA', student: 'Student', reserved: 'Reserved', entry: 'Entry' }[l.tier] || l.tier, trades: 0, raw: l };
    });
    S.selling = data[3].map(function (l) { return { id: l.id, ev: l.eventId, sec: l.section || l.tier, row: '',
      qty: l.qtyAvailable, price: l.priceCents / 100, sold: l.qtyAvailable === 0 || l.status !== 'active', views: 0, offers: [], raw: l }; });
    S.tickets = []; orders.filter(function (o) { return o.status === 'paid'; }).forEach(function (o) {
      o.fills.forEach(function (f) { S.tickets.push({ id: f.id, ev: o.eventId, sec: f.section || f.tier, row: '', seats: f.seatLabel || f.tier,
        qty: f.qty, paid: f.priceCents * f.qty / 100, from: f.sellerName,
        status: f.escrowStatus === 'confirmed' || f.escrowStatus === 'released' ? 'ready' : 'held', orderId: o.id, fill: f }); });
    });
    loading = false; failure = '';
  }
  async function run(task) {
    if (busy) return;
    busy = true;
    document.querySelectorAll('button[type="submit"]').forEach(function (b) { b.disabled = true; });
    var failedForm, errorMessage;
    try { await task(); }
    catch (err) {
      errorMessage = err.message; ui.toast(errorMessage);
      var form = document.querySelector('form[data-backend]');
      if (form) failedForm = Object.fromEntries(new FormData(form));
    }
    finally {
      busy = false; render();
      if (failedForm) {
        var form = document.querySelector('form[data-backend]');
        if (form) Object.keys(failedForm).forEach(function (name) { if (form.elements[name]) form.elements[name].value = failedForm[name]; });
      }
      var status = document.getElementById('backend-error'); if (status && errorMessage) status.textContent = errorMessage;
    }
  }
  async function boot() {
    try {
      await refresh();
      var params = new URLSearchParams(location.search), orderId = params.get('order');
      if (params.get('payment') && orderId && me) {
        // A link for an order on another account shouldn't take down the whole app.
        if (params.get('payment') === 'return') await api('POST', '/api/orders/' + orderId + '/payment/sync').catch(function (err) { if (err.status !== 403 && err.status !== 404) throw err; });
        await refresh();
        if (orders.some(function (o) { return o.id === orderId; })) S.overlay = { k: 'order', id: orderId }; else ui.toast('That order belongs to a different account.');
        history.replaceState(null, '', location.pathname);
      } else if (params.get('seller')) {
        S.overlay = { k: 'payouts' }; history.replaceState(null, '', location.pathname);
      }
    } catch (err) { loading = false; failure = err.message; }
    render(); connectStream();
  }
  function connectStream() {
    if (stream) stream.close();
    if (!me) return;
    stream = new EventSource('/api/stream');
    var timer;
    stream.onmessage = function () {
      clearTimeout(timer); timer = setTimeout(function () {
        if (!busy && !S.overlay && ui.cur().v !== 'sell') refresh().then(function () { render(); }).catch(function () {});
      }, 250);
    };
  }
  function accountPrompt(title) { return shell(title, note('Sign in to see your saved account data.') + button('Sign in', 'login')); }
  var states = { awaiting_payment: 'Awaiting payment', held: 'Waiting for seller transfer', transferred: 'Seller marked sent · confirm receipt', confirmed: 'Receipt confirmed', released: 'Sent to seller’s Stripe balance', refunded: 'Refunded', void: 'Expired' };
  function purchaseCard(o) {
    return '<div class="card"><span class="lt">' + esc(eventName(o.eventId)) + '</span>' + note(o.qty + ' ticket(s) · ' + money(o.totalCents / 100) + ' · ' + o.status.replaceAll('_', ' ')) +
      o.fills.map(function (f) { return note(states[f.escrowStatus] || f.escrowStatus); }).join('') + button('View order', 'order', 'data-id="' + o.id + '"', true) + '</div>';
  }
  function saleCard(o, f) {
    return '<div class="card"><span class="lt">' + esc(eventName(o.eventId)) + '</span>' + note(f.qty + ' ticket(s) · ' + money(f.priceCents * f.qty / 100)) + note(states[f.escrowStatus]) +
      (f.escrowStatus === 'held' ? button('Record transfer', 'transferfill', 'data-order="' + o.id + '" data-fill="' + f.id + '"') : '') +
      (f.transferReference ? note('Reference: ' + f.transferReference) : '') +
      (['transferred', 'confirmed', 'released'].indexOf(f.escrowStatus) >= 0 ? (f.hasProof ? note('Proof uploaded. You’re covered if the buyer files a chargeback.') :
        button('Add proof of delivery', 'prooffill', 'data-order="' + o.id + '" data-fill="' + f.id + '"', true)) : '') +
      (f.problemReportedAt ? note('The buyer reported a problem: ' + f.problemReason + '. Your payment is paused while Teezy reviews it.') : '') +
      (f.escrowStatus === 'confirmed' ? note('Stripe transfer becomes eligible ' + runtime.payoutDelayHours + ' hours after the event starts. Refunds and disputes pause transfers.') : '') + '</div>';
  }

  V.home = function () {
    return originalHome().replace('<div class="body">', '<div class="body">' + paymentNote() + (me ? note('Signed in as ' + me.displayName) : button('Sign in to buy or sell', 'login')) +
      button('Refresh listings', 'reload', '', true) + (runtime.transferTesting ? '<a class="btn btn-ghost" href="/transfer-test.html">Test ticket transfers</a>' : '') + (ui.UPCOMING.length ? '' : empty('No upcoming events yet.')));
  };
  V.search = originalSearch;
  // The designed event page and seat sheet, on real listings. Buying is real; there is no offers or chat
  // API yet, so a lower price saves a price alert instead of sending an offer.
  function alertLabel(price) { return 'Alert me at $' + price + ' or less'; }
  function saveAlert(ev, qty, price) {
    if (!signedIn()) return;
    return run(async function () {
      await api('POST', '/api/desired-tickets', { eventId: ev, qty: Math.min(qty, 10), maxPriceCents: Math.round(price * 100) });
      S.overlay = null; await refresh();
      ui.toast('Alert saved. We’ll notify you when ' + (qty === 1 ? 'a ticket is' : qty + ' tickets are') + ' listed at ' + money(price) + ' or less.');
    });
  }
  function sellBody(p) {
    var mine = S.selling.filter(function (x) { return x.ev === p.ev && !x.sold; }), sold = '';
    sales.filter(function (o) { return o.eventId === p.ev; }).forEach(function (o) { o.fills.forEach(function (f) { sold += saleCard(o, f); }); });
    return sold + mine.map(function (x) {
      return '<div class="card"><div class="between" style="align-items:flex-start"><span><span class="lt">' + esc(x.sec) + ' · ' + x.qty + (x.qty === 1 ? ' ticket' : ' tickets') + '</span><span class="ls">Listed at ' + money(x.price) + ' each</span></span><span class="pill pill-soft">Listed</span></div>' +
        '<div class="btn-grid">' + button('Edit price', 'editprice', 'data-id="' + x.id + '"', true) + button('Withdraw', 'withdraw', 'data-id="' + x.id + '"', true) + '</div></div>';
    }).join('') +
      (mine.length || sold ? '' : '<div class="card"><span class="lt">Nothing listed for this game yet</span><span class="sub">List a ticket you own and can transfer through the official ticketing service.</span></div>') +
      button(mine.length ? 'List another ticket' : 'List a ticket for this game', 'sellfor', 'data-ev="' + esc(p.ev) + '"') + paymentNote();
  }
  V.event = function (p) {
    var e = EV[p.ev]; if (!e) return shell('Event unavailable', button('Back', 'back'));
    if (p.qty == null) p.qty = 1;
    // Start on the cheapest seats that fit, so the main button buys; sliding lower turns it into an alert.
    var fits = S.listings.filter(function (l) { return l.ev === p.ev && l.seats >= p.qty; }).map(function (l) { return l.price; });
    if (p.offer == null && fits.length) p.offer = Math.min.apply(null, fits);
    var html = originalEvent(p);
    if (p.mode === 'sell') return html.split('<div class="body">')[0] + '<div class="body">' + sellBody(p) + '</div>';
    var alertOnly = html.indexOf('data-act="offerall"') >= 0;
    html = html.replace(/(<button class="btn btn-ink btn-full" data-act=")offerall("[^>]*>)[^<]*/, '$1postreq$2' + alertLabel(p.offer))
      .replace(/>Post a request at \$\d+</, '>' + alertLabel(p.offer) + '<')
      .replace(/<button class="link"[^>]*data-act="postreq"[^>]*>[^<]*<\/button>/, function (link) { return alertOnly ? '' : link.replace(/>[^<]*</, '>Or get an alert at $' + p.offer + ' or less<'); })
      .replace('yet · send it as an offer', 'yet · set an alert instead')
      .replace(/<div class="shield">([\s\S]*?)<span>[^<]*<\/span>/, '<div class="shield">$1<span>Teezy holds your payment until you confirm the tickets arrived. ' + (runtime.stripePayments && runtime.paymentMode === 'test' ? 'Stripe test mode · no real money moves.' : runtime.demoPayments ? 'Test checkout · no money is charged.' : '') + '</span>');
    return html;
  };
  O.seatsheet = function (o) {
    var l = S.listings.find(function (x) { return x.id === o.id; });
    if (!l) return panel('Listing unavailable', note('These tickets may have sold. Refresh to see current availability.') + button('Refresh', 'reload'));
    if (o.p == null) o.p = l.price;
    return originalSeatsheet(o).replace(/<button class="uphint"[\s\S]*?<\/button>/, '').replace(' · 0 trades', '')
      .replace('data-off="Offer ${p}"', 'data-off="Alert me at ${p}"').replace(/>Offer \$(\d+)</, '>Alert me at $$$1<');
  };
  V.tickets = function () {
    if (!me) return accountPrompt('My Tickets');
    var tabs = ['Upcoming', 'Selling', 'Past'];
    var body = '<div class="seg">' + tabs.map(function (t) { return '<button data-act="ttab" data-t="' + t + '" class="' + (S.ticketsTab === t ? 'on' : '') + '">' + t + '</button>'; }).join('') + '</div>';
    if (S.ticketsTab === 'Selling') {
      body += button('List a ticket', 'tab', 'data-t="sell"');
      body += S.selling.filter(function (s) { return !s.sold; }).map(function (s) {
        return '<div class="card"><span class="lt">' + esc(eventName(s.ev)) + '</span>' + note(s.qty + ' available · ' + money(s.price) + ' each') +
          '<div class="btn-grid">' + button('Edit price', 'editprice', 'data-id="' + s.id + '"', true) + button('Withdraw', 'withdraw', 'data-id="' + s.id + '"', true) + '</div></div>';
      }).join('');
      body += sales.map(function (o) { return o.fills.map(function (f) { return saleCard(o, f); }).join(''); }).join('');
      if (!S.selling.length && !sales.length) body += empty('Nothing listed or sold yet.');
    } else {
      var list = orders.filter(function (o) { var past = EV[o.eventId] && EV[o.eventId].past || o.status === 'expired' || o.status === 'cancelled'; return S.ticketsTab === 'Past' ? past : !past; });
      body += list.length ? list.map(purchaseCard).join('') : empty('No orders here yet.');
    }
    return shell('My Tickets', body + button('Refresh', 'reload', '', true));
  };
  V.sell = function () {
    if (!me) return accountPrompt('Sell tickets');
    var selected = S.sellEvent || ui.UPCOMING[0];
    return shell('Sell tickets', note('List a ticket you own and can transfer through the official ticketing service.') +
      (runtime.stripePayments ? note(sellerPayments.ready ? 'Seller payouts connected.' : 'Connect seller payouts before you can list tickets.') + button('Seller payouts', 'payouts', '', true) : '') +
      (ui.UPCOMING.length ? '<form data-backend="listing" class="stack"><label class="stack">Event<select class="field" name="eventId">' + ui.UPCOMING.map(function (id) { return '<option value="' + esc(id) + '"' + (selected === id ? ' selected' : '') + '>' + esc(eventName(id)) + '</option>'; }).join('') + '</select></label>' +
        '<label class="stack">Ticket type<select class="field" name="tier"><option value="ga">General admission</option><option value="student">Student</option><option value="reserved">Reserved</option><option value="entry">Entry</option></select></label>' +
        input('Section', 'section', 'text', '', 'maxlength="100"') + input('Row / seat or transfer details', 'seatLabel', 'text', '', 'maxlength="200"') +
        input('Number of tickets', 'qty', 'number', '1', 'min="1" max="20"') + input('Price per ticket ($)', 'price', 'number', '', 'min="0.01" max="100000" step="0.01"') +
        '<p id="backend-error" class="sub" role="alert"></p>' + submit('Publish listing') + '</form>' : empty('An event must be added before you can list tickets.')));
  };
  V.dashboard = function () {
    if (!me) return accountPrompt('Dashboard');
    var content = paymentNote() + button('Payments and payouts', 'payouts', '', true) + '<div class="stat-grid"><div class="stat"><span class="k">Orders</span><span class="v">' + orders.length + '</span></div><div class="stat"><span class="k">Active listings</span><span class="v">' + S.selling.filter(function (s) { return !s.sold; }).length + '</span></div></div>';
    content += '<h2 class="h2">Needs you</h2>';
    orders.filter(function (o) { return o.status === 'pending_payment' || o.fills.some(function (f) { return f.escrowStatus === 'transferred'; }); }).forEach(function (o) { content += purchaseCard(o); });
    sales.forEach(function (o) { o.fills.filter(function (f) { return ['held', 'transferred', 'confirmed'].indexOf(f.escrowStatus) >= 0 || f.problemReportedAt || (!f.hasProof && f.escrowStatus === 'released'); }).forEach(function (f) { content += saleCard(o, f); }); });
    return shell('Dashboard', content + button('Refresh account', 'reload', '', true));
  };
  V.inbox = function () { return me ? shell('Inbox', notifications.length ? notifications.map(function (n) { return '<div class="card"><span class="lt">' + esc(n.title) + '</span>' + note(n.body) + '</div>'; }).join('') : empty('No notifications yet. Transfer updates appear in My Tickets.')) : accountPrompt('Inbox'); };
  V.saved = function () { return shell('Saved', desired.length ? desired.map(function (d) { return '<div class="card"><span class="lt">' + esc(eventName(d.eventId)) + '</span>' + note('Saved ticket alert · ' + money(d.maxPriceCents / 100) + ' maximum') + '</div>'; }).join('') : empty('No saved ticket alerts. Offers and chat are coming in a later step.')); };
  ['friends', 'album', 'org'].forEach(function (name) { V[name] = function () { return shell(name === 'org' ? 'Organizations' : name[0].toUpperCase() + name.slice(1), note('This feature is coming after the ticket marketplace.') + button('Back', 'back', '', true)); }; });
  V.calendar = function () { return shell('Your events', S.tickets.length ? S.tickets.map(function (t) { return '<div class="card"><span class="lt">' + esc(eventName(t.ev)) + '</span>' + note(EV[t.ev].date + ' · ' + EV[t.ev].time) + '</div>'; }).join('') : empty('Your purchased events will appear here.')); };

  O.drawer = function () {
    return panel('Your account', me ? note(me.displayName + (me.email ? ' · ' + me.email : ' · local test account')) +
      button('My Tickets', 'tab', 'data-t="tickets"') + button('Dashboard', 'tab', 'data-t="dashboard"', true) + button('Payments and payouts', 'payouts', '', true) + button('Settings', 'settings', '', true) +
      (runtime.transferTesting ? '<a class="btn btn-ghost" href="/transfer-test.html">Test ticket transfers</a>' : '') + button('Sign out', 'logout', '', true) : note('Sign in with a code sent to your email.') + button('Sign in', 'login'));
  };
  O.login = function () {
    return panel('Sign in', '<form data-backend="login" class="stack">' + input('Email address', 'email', 'email', login.email, 'autocomplete="email" maxlength="254"') +
      (login.sent ? note(login.hint || 'Check your email for a six-digit code.') + input('Verification code', 'code', 'text', login.code, 'inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code"') : '') +
      '<p id="backend-error" class="sub" role="alert"></p>' + submit(login.sent ? 'Verify and sign in' : 'Send sign-in code') + '</form>' + (login.sent ? button('Use another email', 'loginreset', '', true) : ''));
  };
  O.checkout = function (o) {
    var order = o.order;
    if (!order) return panel('Checkout', note('Preparing your order…'));
    return panel('Checkout', note(eventName(order.eventId)) + order.fills.map(function (f) { return note(f.qty + ' ticket(s) from ' + f.sellerName + ' · ' + (f.section || f.tier)); }).join('') +
      note('Tickets: ' + money(order.subtotalCents / 100)) + note('Buyer fee (' + Math.round(order.buyerFeeCents / order.subtotalCents * 100) + '%): ' + money(order.buyerFeeCents / 100)) + '<p class="lt">Total: ' + money(order.totalCents / 100) + '</p>' + paymentNote() +
      note('Reserved until ' + new Date(order.paymentExpiresAt).toLocaleTimeString()) + (demoOrder(order) ? button('Complete test payment', 'pay') : runtime.stripePayments ? button('Continue to Stripe checkout', 'pay') : '') + note('If you close this, you can resume from My Tickets before the reservation expires.'));
  };
  O.order = function (o) {
    var order = orders.find(function (x) { return x.id === o.id; });
    if (!order) return panel('Order unavailable', note('Refresh your account and try again.'));
    return panel('Order details', note(eventName(order.eventId)) + note('Total: ' + money(order.totalCents / 100)) +
      (order.status === 'pending_payment' ? (demoOrder(order) || runtime.stripePayments ? button('Resume checkout', 'resumepay', 'data-id="' + order.id + '"') : paymentNote()) : '') +
      (paymentFor(order.id) ? note('Payment: ' + paymentFor(order.id).status.replaceAll('_', ' ')) +
        (paymentFor(order.id).status === 'succeeded' && order.fills.every(function (f) { return f.escrowStatus === 'held'; }) ? button('Request full refund before delivery', 'refund', 'data-id="' + order.id + '"', true) : '') : '') +
      order.fills.map(function (f) { return '<div class="card"><span class="lt">' + esc(f.section || f.tier) + '</span>' + note(states[f.escrowStatus]) +
        (f.transferReference ? note('Seller reference: ' + f.transferReference) : '') +
        (f.transferredAt ? note('Marked sent: ' + new Date(f.transferredAt).toLocaleString()) : '') +
        (f.confirmedAt ? note('Receipt confirmed: ' + new Date(f.confirmedAt).toLocaleString()) : '') +
        (f.autoConfirmed ? note('Confirmed automatically because no problem was reported.') : '') +
        (f.problemReportedAt ? note('Problem reported. The seller’s payment is paused while Teezy reviews it.') : '') +
        (f.escrowStatus === 'transferred' ? note('Confirm only after checking that the tickets arrived in your official ticketing account.') + button('Confirm receipt', 'confirmfill', 'data-order="' + order.id + '" data-fill="' + f.id + '"') +
          (f.problemReportedAt ? '' : button('Report a problem', 'reportfill', 'data-order="' + order.id + '" data-fill="' + f.id + '"', true) +
            (paymentFor(order.id) && paymentFor(order.id).status === 'succeeded' ? note('If you do nothing, this confirms automatically ' + runtime.autoConfirmHours + ' hours after the event starts.') : '')) : '') + '</div>'; }).join('') +
      note('This screen tracks delivery. It does not contain a scannable admission ticket.'));
  };
  O.report = function (o) {
    return panel('Report a problem', note('Tell us what went wrong with this ticket. The seller won’t be paid while Teezy reviews it.') +
      '<form data-backend="report" data-order="' + o.orderId + '" data-fill="' + o.fillId + '" class="stack">' + input('What happened?', 'reason', 'text', '', 'maxlength="500"') +
      '<p id="backend-error" class="sub" role="alert"></p>' + submit('Send report') + '</form>');
  };
  O.delivery = function (o) {
    return panel('Record ticket transfer', note('Send the tickets in the official ticketing app first. Then record its reference here. This records your declaration; Teezy cannot verify it with the provider yet.') +
      '<form data-backend="delivery" data-order="' + o.orderId + '" data-fill="' + o.fillId + '" class="stack">' + input('Transfer reference', 'reference', 'text', '', 'maxlength="200"') + proofField() +
      '<p id="backend-error" class="sub" role="alert"></p>' + submit('Mark tickets sent') + '</form>');
  };
  O.proof = function (o) {
    return panel('Add proof of delivery', '<form data-backend="proof" data-order="' + o.orderId + '" data-fill="' + o.fillId + '" class="stack">' + proofField() +
      '<p id="backend-error" class="sub" role="alert"></p>' + submit('Save proof') + '</form>');
  };
  O.price = function (o) { var s = S.selling.find(function (x) { return x.id === o.id; }); return panel('Edit listing price', '<form data-backend="price" data-id="' + o.id + '" class="stack">' + input('Price per ticket ($)', 'price', 'number', s.price, 'min="0.01" max="100000" step="0.01"') + '<p id="backend-error" class="sub" role="alert"></p>' + submit('Save price') + '</form>'); };
  O.payouts = function () {
    return panel('Payments and payouts', paymentNote() +
      (runtime.stripePayments ? note(sellerPayments.unavailable ? 'Stripe account status is temporarily unavailable. Refresh to try again.' : sellerPayments.ready ? 'Seller account ready. Stripe handles bank payouts on its payout schedule.' : 'Complete Stripe onboarding to receive seller transfers.') +
        button(sellerPayments.connected ? 'Update seller details' : 'Connect seller payouts', 'onboard') +
        (sellerPayments.connected ? button('Open Stripe payout dashboard', 'stripedashboard', '', true) : '') +
        note('Buyers pay the ticket price plus a 10% Teezy fee. Sellers receive the listed ticket subtotal. Stripe fees are paid by Teezy.') +
        note('Seller transfers require buyer receipt confirmation and wait at least ' + runtime.payoutDelayHours + ' hours after the event starts. Bank arrival depends on Stripe’s payout schedule.') :
        note('Stripe account setup is required to enable card payments and seller payouts.')) +
      transactions.transfers.map(function (t) { return '<div class="card"><span class="lt">' + esc(money(t.amount_cents / 100)) + '</span>' + note(t.status === 'transferred' ? 'Sent to your Stripe balance' : t.status) + '</div>'; }).join('') + button('Refresh account', 'reload', '', true));
  };

  A.login = function () { ui.sheet({ k: 'login' }); };
  A.loginreset = function () { login = { email: '', code: '', sent: false, hint: '' }; ui.sheet({ k: 'login' }); };
  A.logout = function () { return run(async function () { await api('POST', '/api/auth/logout'); S.overlay = null; S.stack = []; S.tab = 'home'; await refresh(); connectStream(); ui.toast('Signed out'); }); };
  A.reload = function () { return run(async function () { await refresh(); connectStream(); ui.toast('Up to date'); }); };
  A.retry = boot;
  A.sellfor = function (d) { S.sellEvent = d.ev; ui.tab('sell'); };
  A.checkout = function (d) {
    if (!signedIn()) return;
    var l = S.listings.find(function (x) { return x.id === d.id; });
    if (!l) return ui.toast('This listing is no longer available. Refresh and try again.');
    return run(async function () {
      var result = await api('POST', '/api/orders', { eventId: l.ev, listingId: l.id, tier: l.tier, qty: Number(d.qty), maxPriceCents: Math.round(l.price * 100) });
      if (!result.matched) { await refresh(); throw new Error('These tickets are unavailable. Choose another listing.'); }
      await refresh(); ui.sheet({ k: 'checkout', order: result.order });
    });
  };
  A.postreq = function (d) { return saveAlert(d.ev, Number(d.qty) || 1, ui.cur().offer); };
  A.seatgo = function () {
    var o = S.overlay, l = S.listings.find(function (x) { return x.id === o.id; });
    if (!l) return ui.toast('This listing is no longer available. Refresh and try again.');
    var qty = Math.min(o.qty || 1, l.seats);
    return o.p >= l.price ? A.checkout({ id: l.id, qty: qty }) : saveAlert(l.ev, qty, o.p);
  };
  A.resumepay = function (d) { var order = orders.find(function (o) { return o.id === d.id; }); ui.sheet({ k: 'checkout', order: order }); };
  A.pay = function () { var order = S.overlay.order; return run(async function () {
    if (runtime.stripePayments && !demoOrder(order)) {
      var result = await api('POST', '/api/orders/' + order.id + '/checkout'); window.location.assign(result.url); return;
    }
    await api('POST', '/api/orders/' + order.id + '/pay'); await refresh(); S.overlay = { k: 'order', id: order.id }; ui.toast('Test payment saved. Waiting for the seller to transfer.');
  }); };
  A.payouts = function () { if (signedIn()) ui.sheet({ k: 'payouts' }); };
  A.onboard = function () {
    if (runtime.stripePublishableKey) return openOnboarding();
    return run(async function () { var result = await api('POST', '/api/me/seller-onboarding'); window.location.assign(result.url); });
  };
  // Stripe's onboarding form, shown inside the app. It lives outside the render root so redraws keep it.
  var connectScript, connectInstance;
  function loadConnect() {
    if (!connectScript) connectScript = new Promise(function (resolve, reject) {
      window.StripeConnect = window.StripeConnect || {};
      window.StripeConnect.onLoad = function () { resolve(window.StripeConnect); };
      var tag = document.createElement('script');
      tag.src = 'https://connect-js.stripe.com/v1.0/connect.js'; tag.async = true;
      tag.onload = function () { if (window.StripeConnect.init) resolve(window.StripeConnect); };
      tag.onerror = function () { connectScript = null; reject(new Error('Stripe could not load. Check your connection and try again.')); };
      document.head.appendChild(tag);
    });
    return connectScript;
  }
  function closeOnboarding() {
    var host = document.getElementById('stripe-onboard'); if (host) host.remove();
    return run(async function () { await refresh(); ui.sheet({ k: 'payouts' }); });
  }
  function openOnboarding() {
    if (document.getElementById('stripe-onboard')) return;
    var screen = document.getElementById('screen') || document.body, css = getComputedStyle(document.documentElement);
    var host = document.createElement('div');
    host.id = 'stripe-onboard'; host.setAttribute('role', 'dialog'); host.setAttribute('aria-label', 'Seller payout setup');
    host.style.cssText = 'position:absolute;inset:0;z-index:40;background:var(--bg);display:flex;flex-direction:column;padding-top:env(safe-area-inset-top,0px);animation:up .26s ease';
    host.innerHTML = '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:18px 18px 10px">' +
      '<h2 class="title" style="font-size:1.3rem;margin:0">Seller payouts</h2>' +
      '<button class="btn btn-ghost" data-close-onboard>Close</button></div>' +
      '<p class="sub" style="margin:0 18px 8px">Stripe test mode · use Stripe’s test data buttons.</p>' +
      '<div data-mount style="flex:1;overflow-y:auto;padding:0 18px calc(24px + env(safe-area-inset-bottom,0px))"><p class="sub">Loading Stripe…</p></div>';
    screen.appendChild(host);
    host.querySelector('[data-close-onboard]').onclick = closeOnboarding;
    loadConnect().then(function (StripeConnect) {
      if (!connectInstance) connectInstance = StripeConnect.init({
        publishableKey: runtime.stripePublishableKey,
        fetchClientSecret: async function () { return (await api('POST', '/api/me/seller-onboarding/session')).clientSecret; },
        appearance: { variables: { colorPrimary: css.getPropertyValue('--accent').trim() || '#FF6A13',
          colorBackground: css.getPropertyValue('--bg').trim() || '#FFFFFF', colorText: css.getPropertyValue('--ink').trim() || '#0E0E10',
          fontFamily: 'Archivo, system-ui, -apple-system, sans-serif', borderRadius: '12px' } },
        fonts: [{ cssSrc: 'https://fonts.googleapis.com/css2?family=Archivo:wght@400;600;800&display=swap' }],
      });
      var form = connectInstance.create('account-onboarding');
      form.setOnExit(closeOnboarding);
      if (form.setOnLoadError) form.setOnLoadError(function (e) { ui.toast((e.error && e.error.message) || 'Stripe could not load the form.'); });
      var mount = host.querySelector('[data-mount]'); mount.innerHTML = ''; mount.appendChild(form);
    }).catch(function (err) { host.remove(); ui.toast(err.message); });
  }
  A.stripedashboard = function () { return run(async function () { var result = await api('POST', '/api/me/seller-dashboard'); window.location.assign(result.url); }); };
  A.refund = function (d) { return run(async function () { await api('POST', '/api/orders/' + d.id + '/refund'); await refresh(); ui.sheet({ k: 'order', id: d.id }); ui.toast('Refund requested. Its status is saved with your payment.'); }); };
  A.order = function (d) { ui.sheet({ k: 'order', id: d.id }); };
  A.showticket = function (d) { var t = S.tickets.find(function (x) { return x.id === d.id; }); if (t) ui.sheet({ k: 'order', id: t.orderId }); };
  A.transferfill = function (d) { ui.sheet({ k: 'delivery', orderId: d.order, fillId: d.fill }); };
  A.prooffill = function (d) { ui.sheet({ k: 'proof', orderId: d.order, fillId: d.fill }); };
  A.reportfill = function (d) { ui.sheet({ k: 'report', orderId: d.order, fillId: d.fill }); };
  A.confirmfill = function (d) { return run(async function () { await api('POST', '/api/orders/' + d.order + '/fills/' + d.fill + '/confirm'); await refresh(); ui.sheet({ k: 'order', id: d.order }); ui.toast('Receipt confirmed and saved'); }); };
  A.withdraw = function (d) { return run(async function () { await api('PATCH', '/api/listings/' + d.id, { withdraw: true }); await refresh(); ui.toast('Listing withdrawn'); }); };
  ['sendoffer', 'offerall', 'acceptoffer', 'sendcounter', 'fill', 'takeoffer', 'cashout', 'scan', 'dotransfer', 'transfer', 'sellticket', 'chatwith', 'seatchat', 'evlist', 'seeoffers', 'sellparking'].forEach(function (name) {
    A[name] = function () { ui.toast('This feature is not connected yet. Use listings and checkout for now.'); };
  });
  // Account data must never be replaced by the demo's simulated actions.
  A.listnow = A.saveprice = function () { ui.toast('Use the listing form to save changes.'); };

  document.addEventListener('submit', function (event) {
    var form = event.target, kind = form.dataset.backend;
    if (!kind) return;
    event.preventDefault();
    var values = Object.fromEntries(new FormData(form));
    if (kind === 'login') { login.email = values.email.trim(); login.code = values.code || ''; }
    run(async function () {
      if (kind === 'login') {
        if (!login.sent) {
          var result = await api('POST', '/api/auth/email/start', { email: login.email });
          login.sent = true; login.code = result.devCode || ''; login.hint = result.devCode ? 'Local test code: ' + result.devCode + ' (no email sent in development mode).' : 'Enter the six-digit code sent to your email.';
        } else {
          await api('POST', '/api/auth/email/verify', { email: login.email, code: login.code });
          S.overlay = null; await refresh(); connectStream(); login = { email: '', code: '', sent: false, hint: '' }; ui.toast('Signed in');
        }
      } else if (kind === 'listing') {
        await api('POST', '/api/listings', { eventId: values.eventId, tier: values.tier, section: values.section,
          seatLabel: values.seatLabel, qty: Number(values.qty), priceCents: Math.round(Number(values.price) * 100), acceptsOffers: false });
        await refresh(); S.ticketsTab = 'Selling'; ui.tab('tickets'); ui.toast('Listing published and saved');
      } else if (kind === 'price') {
        await api('PATCH', '/api/listings/' + form.dataset.id, { priceCents: Math.round(Number(values.price) * 100) });
        S.overlay = null; await refresh(); ui.toast('Price saved');
      } else if (kind === 'delivery') {
        await api('POST', '/api/orders/' + form.dataset.order + '/fills/' + form.dataset.fill + '/transfer', { reference: values.reference });
        if (values.proof && values.proof.size) await api('POST', '/api/orders/' + form.dataset.order + '/fills/' + form.dataset.fill + '/proof', await readProof(values.proof));
        S.overlay = null; await refresh(); ui.toast('Transfer recorded. Waiting for buyer confirmation.');
      } else if (kind === 'proof') {
        if (!values.proof || !values.proof.size) throw new Error('Choose a file first.');
        await api('POST', '/api/orders/' + form.dataset.order + '/fills/' + form.dataset.fill + '/proof', await readProof(values.proof));
        S.overlay = null; await refresh(); ui.toast('Proof saved. You’re covered if the buyer files a chargeback.');
      } else if (kind === 'report') {
        await api('POST', '/api/orders/' + form.dataset.order + '/fills/' + form.dataset.fill + '/report', { reason: values.reason });
        await refresh(); ui.sheet({ k: 'order', id: form.dataset.order }); ui.toast('Problem reported. The seller’s payment is paused.');
      }
    });
  });
  Object.keys(V).forEach(function (name) {
    var view = V[name]; V[name] = function (params) {
      if (loading) return shell('Teezy', note('Loading your marketplace…'));
      if (failure) return shell('Connection needed', note(failure) + button('Retry', 'retry'));
      return view(params);
    };
  });
  window.addEventListener('focus', function () { if (!busy && !S.overlay && ui.cur().v !== 'sell') refresh().then(function () { render(); }).catch(function () {}); });
  var intro = document.querySelector('.intro p'); if (intro) intro.textContent = 'Browse, list and buy tickets. Your account and transfer progress are saved.';
  boot();
};
