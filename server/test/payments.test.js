import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Stripe from 'stripe';
import { config } from '../config.js';
import { query } from '../db.js';
import { buildApp } from '../app.js';
import { resetDb, addListing, order } from './helpers.js';
import { buyAtPrice, expireOrder, getOrder, recordTransfer, confirmTransfer, reportProblem, saveDeliveryProof } from '../services/orders.js';
import { startCheckout, processWebhook, startSellerOnboarding, getSellerPayments, requestRefund, paymentSweep, syncPayment, disputeReport } from '../services/payments.js';
import { stripeClient } from '../services/stripe.js';
import { createListing } from '../services/listings.js';

function fakeStripe() {
  const sessions = new Map(), transfers = new Map(), refunds = new Map(), calls = [];
  const sdk = new Stripe('sk_test_unit');
  let count = 0;
  const client = {
    webhooks: sdk.webhooks, sessions, transfersMade: transfers, refundsMade: refunds, calls,
    accounts: { createLoginLink: async () => ({ url: 'https://connect.stripe.com/express/test' }) },
    v2: { core: {
      accounts: {
        create: async (params, options) => { calls.push(['account', params, options]); return { id: 'acct_created' }; },
        retrieve: async (id) => client.accountState?.(id) ?? { id, requirements: { entries: [] },
          configuration: { recipient: { capabilities: { stripe_balance: { stripe_transfers: { status: 'active' }, payouts: { status: 'active' } } } } } },
      },
      accountLinks: { create: async (params) => { calls.push(['link', params]); return { url: 'https://connect.stripe.com/setup/test' }; } },
    } },
    disputes: {
      state: {},
      retrieve: async (id) => client.disputes.state[id] ?? { id, status: 'needs_response', amount: 4400 },
      update: async (id, params, options) => { calls.push(['evidence', params, options]); client.disputes.state[id] = { id, status: 'under_review', amount: 4400 }; return client.disputes.state[id]; },
    },
    events: { saved: {}, retrieve: async (id) => client.events.saved[id] },
    files: { create: async (params) => { calls.push(['file', params]); return { id: 'file_' + (++count) }; } },
    checkout: { sessions: {
      create: async (params, options) => {
        calls.push(['checkout', params, options]);
        const existing = [...sessions.values()].find((s) => s.client_reference_id === params.client_reference_id);
        if (existing) return existing;
        const session = { id: 'cs_test_' + (++count), status: 'open', payment_status: 'unpaid', livemode: false,
          url: 'https://checkout.stripe.com/c/pay/test', amount_total: params.line_items[0].price_data.unit_amount,
          currency: 'usd', client_reference_id: params.client_reference_id, payment_intent: 'pi_' + params.client_reference_id,
          metadata: params.metadata, expires_at: params.expires_at };
        sessions.set(session.id, session); return session;
      },
      retrieve: async (id) => { const session = sessions.get(id); if (!session) throw new Error('unknown session'); return session; },
      expire: async (id) => { const s = sessions.get(id); if (s.payment_status === 'paid') throw new Error('already paid'); s.status = 'expired'; return s; },
    } },
    paymentIntents: { retrieve: async (id) => {
      const session = [...sessions.values()].find((s) => s.payment_intent === id);
      return { id, status: session.payment_status === 'paid' ? 'succeeded' : 'requires_payment_method',
        amount_received: session.amount_total, currency: session.currency, livemode: session.livemode, latest_charge: 'ch_' + id };
    } },
    refunds: {
      create: async (params, options) => {
        calls.push(['refund', params, options]);
        if (!refunds.has(options.idempotencyKey)) refunds.set(options.idempotencyKey, { id: 're_' + (++count), amount: params.amount, status: 'succeeded', payment_intent: params.payment_intent });
        return refunds.get(options.idempotencyKey);
      },
      list: async () => ({ data: [...refunds.values()] }),
      retrieve: async (id) => [...refunds.values()].find((r) => r.id === id),
    },
    charges: { retrieve: async (id) => ({ id, metadata: { orderId: 'order' }, amount_refunded: [...refunds.values()].filter((r) => 'ch_' + r.payment_intent === id).reduce((n, r) => n + r.amount, 0) }) },
    transfers: {
      create: async (params, options) => {
        calls.push(['transfer', params, options]);
        if (!transfers.has(options.idempotencyKey)) transfers.set(options.idempotencyKey, { id: 'tr_' + (++count), ...params });
        const result = transfers.get(options.idempotencyKey);
        if (client.loseTransferResponse) { client.loseTransferResponse = false; throw new Error('connection lost after provider accepted transfer'); }
        return result;
      },
      retrieve: async (id) => [...transfers.values()].find((t) => t.id === id),
      createReversal: async (id) => { const t = [...transfers.values()].find((t) => t.id === id); return { id: 'rev_' + id, amount: t.amount }; },
    },
  };
  return client;
}

let stripe, saved;
async function checkout() {
  await addListing({ seller: 's1', price: 40 });
  const { order: o } = await buyAtPrice(order());
  const result = await startCheckout(o.id, 'buyer', stripe);
  return { order: o, session: stripe.sessions.get(result.sessionId) };
}
async function markPaid(session, id = 'evt_paid') {
  session.status = 'complete'; session.payment_status = 'paid';
  await processWebhook({ id, type: 'checkout.session.completed', livemode: false, data: { object: session } }, stripe);
}
async function deliver(o) {
  await recordTransfer(o.id, o.fills[0].id, 's1', 'PROVIDER-TRANSFER');
  await confirmTransfer(o.id, o.fills[0].id, 'buyer');
}
async function due(o) { await query("UPDATE events SET starts_at=now()-interval '2 days' WHERE id=$1", [o.eventId]); }
async function payment(id) { return (await query('SELECT * FROM payments WHERE order_id=$1', [id])).rows[0]; }

describe('Stripe marketplace payments', () => {
  beforeEach(async () => {
    saved = { paymentProvider: config.paymentProvider, stripeSecretKey: config.stripeSecretKey, stripeWebhookSecret: config.stripeWebhookSecret,
      publicUrl: config.publicUrl, allowLivePayments: config.allowLivePayments, payoutDelayHours: config.payoutDelayHours };
    saved.stripeConnectWebhookSecret = config.stripeConnectWebhookSecret; saved.autoConfirmHours = config.autoConfirmHours;
    Object.assign(config, { paymentProvider: 'stripe', stripeSecretKey: 'sk_test_unit', stripeWebhookSecret: 'whsec_unit',
      stripeConnectWebhookSecret: '', autoConfirmHours: 24,
      publicUrl: 'http://localhost:3001', allowLivePayments: false, payoutDelayHours: 24 });
    await resetDb(); stripe = fakeStripe();
    await query("UPDATE users SET email=id || '@example.com',email_verified_at=now()");
    await query("INSERT INTO seller_accounts(user_id,stripe_account_id,livemode) VALUES ('s1','acct_s1',false),('s2','acct_s2',false)");
  });
  afterEach(() => Object.assign(config, saved));

  it('uses repeatable Checkout requests, server totals, Dashboard payment methods, and extended reservations', async () => {
    const { order: o } = await checkout();
    const second = await startCheckout(o.id, 'buyer', stripe);
    assert.equal(stripe.sessions.size, 1);
    assert.equal(second.sessionId, (await payment(o.id)).stripe_session_id);
    const call = stripe.calls.find((c) => c[0] === 'checkout');
    assert.equal(call[1].line_items[0].price_data.unit_amount, 4400);
    assert.equal(call[1].payment_method_types, undefined);
    assert.ok(call[1].expires_at * 1000 > Date.now() + 30 * 60 * 1000);
    assert.match(call[2].idempotencyKey, new RegExp(o.id));
    await assert.rejects(startCheckout(o.id, 'buyer2', stripe), { code: 'forbidden' });
    await query("UPDATE orders SET payment_expires_at=now()-interval '1 second' WHERE id=$1", [o.id]);
    await assert.rejects(startCheckout(o.id, 'buyer', stripe), { code: 'not_payable' });
  });

  it('requires seller onboarding and verified buyer email before accepting payment', async () => {
    await query("DELETE FROM seller_accounts WHERE user_id='s1'");
    await addListing({ seller: 's1', price: 40 });
    const { order: o } = await buyAtPrice(order());
    await assert.rejects(startCheckout(o.id, 'buyer', stripe), { code: 'seller_not_ready' });
    await query("UPDATE users SET email_verified_at=NULL WHERE id='buyer'");
    await assert.rejects(startCheckout(o.id, 'buyer', stripe), { code: 'forbidden' });
  });

  it('creates one connected seller account and refreshes onboarding links', async () => {
    await startSellerOnboarding('s3', stripe);
    await startSellerOnboarding('s3', stripe);
    assert.equal(stripe.calls.filter((c) => c[0] === 'account').length, 1);
    assert.equal((await query("SELECT stripe_account_id FROM seller_accounts WHERE user_id='s3'")).rows[0].stripe_account_id, 'acct_created');
  });

  it('creates Accounts v2 recipients where Teezy owns fees and losses', async () => {
    await startSellerOnboarding('s3', stripe);
    const [, params] = stripe.calls.find((c) => c[0] === 'account');
    assert.equal(params.dashboard, 'express');
    assert.deepEqual(params.defaults.responsibilities, { fees_collector: 'application', losses_collector: 'application' });
    assert.equal(params.configuration.recipient.capabilities.stripe_balance.stripe_transfers.requested, true);
    const [, link] = stripe.calls.find((c) => c[0] === 'link');
    assert.equal(link.use_case.type, 'account_onboarding');
    assert.equal(link.use_case.account_onboarding.return_url, 'http://localhost:3001/?seller=return');
  });

  it('blocks payment until the seller can receive transfers, and reports what is due', async () => {
    stripe.accountState = (id) => ({ id, configuration: { recipient: { capabilities: { stripe_balance: { stripe_transfers: { status: 'restricted' } } } } },
      requirements: { entries: [{ description: 'identity_document', minimum_deadline: { status: 'currently_due' } }, { description: 'later', minimum_deadline: { status: 'eventually_due' } }] } });
    assert.deepEqual(await getSellerPayments('s1', stripe), { connected: true, ready: false, transfersEnabled: false,
      payoutsEnabled: false, detailsSubmitted: false, requirements: ['identity_document'] });
    await addListing({ seller: 's1', price: 40 });
    const { order: o } = await buyAtPrice(order());
    await assert.rejects(startCheckout(o.id, 'buyer', stripe), { code: 'seller_not_ready' });
  });

  it('explains when Stripe requires account-owner platform setup instead of changing loss responsibility', async () => {
    stripe.v2.core.accounts.create = async () => { throw new Error('You tried to create a connected account with your platform as the losses collector.'); };
    await assert.rejects(startSellerOnboarding('s3', stripe), { code: 'stripe_platform_setup_required', status: 503 });
    assert.equal((await query("SELECT * FROM seller_accounts WHERE user_id='s3'")).rows.length, 0);
  });

  it('shows Stripe\'s real reason for other seller setup refusals outside production', async () => {
    stripe.v2.core.accounts.create = async () => { throw Object.assign(new Error('Unsupported account setup.'), { type: 'StripeInvalidRequestError' }); };
    await assert.rejects(startSellerOnboarding('s3', stripe), { code: 'stripe_seller_setup_failed', status: 502, message: /Unsupported account setup/ });
    assert.equal((await query("SELECT * FROM seller_accounts WHERE user_id='s3'")).rows.length, 0);
  });

  it('only marks payment paid after provider verification, and deduplicates repeated webhooks', async () => {
    const { order: o, session } = await checkout();
    assert.equal((await payment(o.id)).status, 'pending');
    await markPaid(session);
    await markPaid(session);
    await markPaid(session, 'evt_second_delivery');
    assert.equal((await payment(o.id)).status, 'succeeded');
    assert.equal((await query("SELECT count(*)::int AS n FROM payment_ledger WHERE kind='charge'")).rows[0].n, 1);
    assert.equal((await query('SELECT status FROM orders WHERE id=$1', [o.id])).rows[0].status, 'paid');
  });

  it('rejects wrong payment amounts and mismatched modes', async () => {
    const { session } = await checkout(); session.amount_total = 1;
    await assert.rejects(markPaid(session), { code: 'payment_mismatch' });
    await assert.rejects(processWebhook({ id: 'evt_live', type: 'account.updated', livemode: true, data: { object: {} } }, stripe), { code: 'bad_request' });
  });

  it('acknowledges test Connect events on a live endpoint without processing them', async () => {
    Object.assign(config, { stripeSecretKey: 'sk_live_unit', allowLivePayments: true });
    await processWebhook({ id: 'evt_test_connect', type: 'account.updated', livemode: false, account: 'acct_s1', data: { object: { id: 'acct_s1' } } }, stripe);
    assert.equal((await query("SELECT * FROM payment_webhooks WHERE event_id='evt_test_connect'")).rows.length, 0);
    await assert.rejects(processWebhook({ id: 'evt_test_platform', type: 'account.updated', livemode: false, data: { object: {} } }, stripe), { code: 'bad_request' });
  });

  it('accepts events signed with either the platform or Connect secret, and nothing else', async () => {
    config.stripeConnectWebhookSecret = 'whsec_connect';
    const send = (app, id, secret) => { const payload = JSON.stringify({ id, type: 'account.updated', account: 'acct_s1', livemode: false, data: { object: { id: 'acct_s1' } } });
      return app.inject({ method: 'POST', url: '/api/webhooks/stripe', payload,
        headers: { 'content-type': 'application/json', 'stripe-signature': stripe.webhooks.generateTestHeaderString({ payload, secret }) } }); };
    const app = buildApp({ stripe });
    try {
      assert.equal((await send(app, 'evt_a', 'whsec_unit')).statusCode, 200);
      assert.equal((await send(app, 'evt_b', 'whsec_connect')).statusCode, 200);
      assert.equal((await send(app, 'evt_c', 'whsec_forged')).statusCode, 400);
    } finally { await app.close(); }
  });

  it('verifies original webhook bytes and rejects forged signatures', async () => {
    const { order: o, session } = await checkout(); session.status = 'complete'; session.payment_status = 'paid';
    const payload = JSON.stringify({ id: 'evt_signed', type: 'checkout.session.completed', livemode: false, data: { object: session } });
    const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: config.stripeWebhookSecret });
    const app = buildApp({ stripe });
    try {
      const headers = { 'content-type': 'application/json', 'stripe-signature': signature };
      assert.equal((await app.inject({ method: 'POST', url: '/api/webhooks/stripe', headers, payload: payload + ' ' })).statusCode, 400);
      assert.equal((await payment(o.id)).status, 'pending');
      assert.equal((await app.inject({ method: 'POST', url: '/api/webhooks/stripe', headers, payload })).statusCode, 200);
      assert.equal((await payment(o.id)).status, 'succeeded');
    } finally { await app.close(); }
  });

  it('blocks demo-payment shortcuts and spoofed identities when Stripe is selected', async () => {
    const { order: o } = await checkout();
    const app = buildApp({ stripe });
    try {
      assert.equal((await app.inject({ method: 'POST', url: `/api/orders/${o.id}/pay`, headers: { 'x-user-id': 'buyer' } })).statusCode, 400);
      assert.equal((await app.inject({ method: 'POST', url: `/api/orders/${o.id}/checkout`, headers: { 'x-user-id': 'buyer' } })).statusCode, 401);
      assert.equal((await app.inject({ method: 'GET', url: '/api/me/payments', headers: { 'x-user-id': 'buyer' } })).statusCode, 401);
    } finally { await app.close(); }
  });

  it('expires unpaid provider checkout before restoring seats', async () => {
    const { order: o, session } = await checkout();
    await query("UPDATE orders SET payment_expires_at=now()-interval '1 second' WHERE id=$1", [o.id]);
    assert.equal(await expireOrder(o.id, stripe), true);
    assert.equal(session.status, 'expired');
    assert.equal((await query('SELECT qty_available FROM listings WHERE id=$1', [o.fills[0].listingId])).rows[0].qty_available, 1);
  });

  it('reconciles payment that wins the expiration race without restoring inventory', async () => {
    const { order: o, session } = await checkout(); session.status = 'complete'; session.payment_status = 'paid';
    await query("UPDATE orders SET payment_expires_at=now()-interval '1 second' WHERE id=$1", [o.id]);
    assert.equal(await expireOrder(o.id, stripe), false);
    assert.equal((await payment(o.id)).status, 'succeeded');
    assert.equal((await query('SELECT qty_available FROM listings WHERE id=$1', [o.fills[0].listingId])).rows[0].qty_available, 0);
  });

  it('refunds a late payment on expired inventory instead of resurrecting the order', async () => {
    const { order: o, session } = await checkout();
    await query("UPDATE orders SET payment_expires_at=now()-interval '1 second' WHERE id=$1", [o.id]);
    await expireOrder(o.id, stripe); await markPaid(session);
    assert.equal((await payment(o.id)).status, 'refund_pending');
    await paymentSweep(stripe);
    assert.equal((await payment(o.id)).status, 'refunded');
    assert.equal((await query('SELECT status FROM orders WHERE id=$1', [o.id])).rows[0].status, 'expired');
  });

  it('issues one refund before delivery and prevents seller payout', async () => {
    const { order: o, session } = await checkout(); await markPaid(session);
    await assert.rejects(requestRefund(o.id, 'buyer2', stripe), { code: 'forbidden' });
    await requestRefund(o.id, 'buyer', stripe); await requestRefund(o.id, 'buyer', stripe);
    assert.equal(stripe.refundsMade.size, 1);
    assert.equal((await payment(o.id)).status, 'refunded');
    await due(o); await paymentSweep(stripe);
    assert.equal(stripe.transfersMade.size, 0);
  });

  it('requires support review for refunds after seller delivery', async () => {
    const { order: o, session } = await checkout(); await markPaid(session); await deliver(o);
    await assert.rejects(requestRefund(o.id, 'buyer', stripe), { code: 'refund_needs_review' });
  });

  it('only transfers the seller subtotal after confirmation AND the event delay, exactly once', async () => {
    const { order: o, session } = await checkout(); await markPaid(session);
    await paymentSweep(stripe); assert.equal(stripe.transfersMade.size, 0);
    await deliver(o); await paymentSweep(stripe); assert.equal(stripe.transfersMade.size, 0);
    await due(o); await paymentSweep(stripe); await paymentSweep(stripe);
    assert.equal(stripe.transfersMade.size, 1);
    const transfer = [...stripe.transfersMade.values()][0];
    assert.equal(transfer.amount, 4000); assert.equal(transfer.destination, 'acct_s1');
    assert.equal(transfer.source_transaction, (await payment(o.id)).stripe_charge_id);
    assert.equal((await query('SELECT escrow_status FROM order_fills WHERE order_id=$1', [o.id])).rows[0].escrow_status, 'released');
  });

  it('retries a lost transfer response without paying twice', async () => {
    const { order: o, session } = await checkout(); await markPaid(session); await deliver(o); await due(o);
    stripe.loseTransferResponse = true;
    await assert.rejects(paymentSweep(stripe), AggregateError);
    await paymentSweep(stripe);
    assert.equal(stripe.transfersMade.size, 1);
    assert.equal((await query("SELECT count(*)::int AS n FROM payment_ledger WHERE kind='transfer'")).rows[0].n, 1);
  });

  it('recovers a lost provider transfer response via webhook and reverses it on refund', async () => {
    const { order: o, session } = await checkout(); await markPaid(session); await deliver(o); await due(o);
    stripe.loseTransferResponse = true; await assert.rejects(paymentSweep(stripe), AggregateError);
    const transfer = [...stripe.transfersMade.values()][0];
    await stripe.refunds.create({ payment_intent: session.payment_intent, amount: 4400 }, { idempotencyKey: 'external-refund' });
    await processWebhook({ id: 'evt_refund', livemode: false, type: 'charge.refunded', data: { object: { object: 'charge', id: 'ch_' + session.payment_intent } } }, stripe);
    await processWebhook({ id: 'evt_transfer', livemode: false, type: 'transfer.created', data: { object: transfer } }, stripe);
    await paymentSweep(stripe);
    assert.equal((await query('SELECT status FROM seller_transfers WHERE fill_id=$1', [o.fills[0].id])).rows[0].status, 'reversed');
  });

  it('freezes disputed payments before seller transfer', async () => {
    const { order: o, session } = await checkout(); await markPaid(session); await deliver(o); await due(o);
    await processWebhook({ id: 'evt_dispute', type: 'charge.dispute.created', livemode: false,
      data: { object: { id: 'dp_test', object: 'dispute', charge: 'ch_' + session.payment_intent, amount: 4400 } } }, stripe);
    await paymentSweep(stripe);
    assert.equal((await payment(o.id)).status, 'disputed'); assert.equal(stripe.transfersMade.size, 0);
  });

  it('lets return-page sync verify provider payment without trusting browser success parameters', async () => {
    const { order: o, session } = await checkout();
    await syncPayment(o.id, 'buyer', stripe); assert.equal((await payment(o.id)).status, 'pending');
    await assert.rejects(syncPayment(o.id, 'buyer2', stripe), { code: 'forbidden' });
    session.status = 'complete'; session.payment_status = 'paid'; await syncPayment(o.id, 'buyer', stripe);
    assert.equal((await payment(o.id)).status, 'succeeded');
  });

  it('requires explicit enablement and HTTPS before live keys can be used', () => {
    config.stripeSecretKey = 'sk_live_unit';
    assert.throws(() => stripeClient(), { code: 'live_payments_disabled' });
    config.allowLivePayments = true;
    assert.throws(() => stripeClient(), /HTTPS/);
    config.publicUrl = 'https://teezy.example';
    assert.throws(() => stripeClient(), /STRIPE_CONNECT_WEBHOOK_SECRET/);
  });

  it('recovers a paid Checkout whose create response was lost before saving the session ID', async () => {
    const { order: o, session } = await checkout();
    await query('UPDATE payments SET stripe_session_id=NULL WHERE order_id=$1', [o.id]);
    await markPaid(session);
    assert.equal((await payment(o.id)).stripe_session_id, session.id);
    assert.equal((await payment(o.id)).status, 'succeeded');
  });

  it('keeps inventory reserved if provider checkout creation is unresolved', async () => {
    const { order: o } = await checkout();
    await query('UPDATE payments SET stripe_session_id=NULL WHERE order_id=$1', [o.id]);
    await query("UPDATE orders SET payment_expires_at=now()-interval '1 second' WHERE id=$1", [o.id]);
    await assert.rejects(expireOrder(o.id, stripe), /unresolved/);
    assert.equal((await query('SELECT status FROM orders WHERE id=$1', [o.id])).rows[0].status, 'pending_payment');
    assert.equal((await query('SELECT qty_available FROM listings WHERE id=$1', [o.fills[0].listingId])).rows[0].qty_available, 0);
  });

  it('lets the buyer retry after Stripe refuses Checkout, with a fresh expiry and key', async () => {
    await addListing({ seller: 's1', price: 40 });
    const { order: o } = await buyAtPrice(order());
    const create = stripe.checkout.sessions.create;
    stripe.checkout.sessions.create = async (params, options) => { calls.push(options.idempotencyKey); throw Object.assign(new Error('Unsupported parameter.'), { type: 'StripeInvalidRequestError', statusCode: 400 }); };
    const calls = [];
    await assert.rejects(startCheckout(o.id, 'buyer', stripe), { code: 'checkout_failed', status: 502, message: /Unsupported parameter/ });
    assert.equal(await payment(o.id), undefined);
    stripe.checkout.sessions.create = async (params, options) => { calls.push(options.idempotencyKey); return create(params, options); };
    const result = await startCheckout(o.id, 'buyer', stripe);
    assert.equal((await payment(o.id)).stripe_session_id, result.sessionId);
    assert.notEqual(calls[0], calls[1]);
  });

  it('returns seats when Stripe refused Checkout and the reservation runs out', async () => {
    await addListing({ seller: 's1', price: 40 });
    const { order: o } = await buyAtPrice(order());
    stripe.checkout.sessions.create = async () => { throw Object.assign(new Error('Unsupported parameter.'), { type: 'StripeInvalidRequestError', statusCode: 400 }); };
    await assert.rejects(startCheckout(o.id, 'buyer', stripe), { code: 'checkout_failed' });
    await query("UPDATE orders SET payment_expires_at=now()-interval '1 second' WHERE id=$1", [o.id]);
    assert.equal(await expireOrder(o.id, stripe), true);
    assert.equal((await query('SELECT qty_available FROM listings WHERE id=$1', [o.fills[0].listingId])).rows[0].qty_available, 1);
  });

  async function sent() {
    const { order: o, session } = await checkout();
    await markPaid(session);
    await recordTransfer(o.id, o.fills[0].id, 's1', 'PROVIDER-TRANSFER');
    return o;
  }
  const fill = async (o) => (await query('SELECT * FROM order_fills WHERE id=$1', [o.fills[0].id])).rows[0];

  it('auto-confirms a silent buyer after the window and pays the seller exactly once', async () => {
    const o = await sent();
    await paymentSweep(stripe);
    assert.equal((await fill(o)).escrow_status, 'transferred');
    await due(o);
    await paymentSweep(stripe); await paymentSweep(stripe);
    const f = await fill(o);
    assert.equal(f.escrow_status, 'released');
    assert.equal(f.auto_confirmed, true);
    assert.equal(stripe.transfersMade.size, 1);
  });

  it('keeps a reported delivery unpaid after the window', async () => {
    const o = await sent();
    await assert.rejects(reportProblem(o.id, o.fills[0].id, 'buyer2', 'not mine'), { code: 'forbidden' });
    await assert.rejects(reportProblem(o.id, o.fills[0].id, 'buyer', '  '), { code: 'bad_request' });
    await reportProblem(o.id, o.fills[0].id, 'buyer', 'Ticket never arrived');
    await assert.rejects(reportProblem(o.id, o.fills[0].id, 'buyer', 'again'), { code: 'wrong_step' });
    await due(o);
    await paymentSweep(stripe);
    assert.equal((await fill(o)).escrow_status, 'transferred');
    assert.equal(stripe.transfersMade.size, 0);
  });

  it('never auto-confirms a disputed payment', async () => {
    const o = await sent();
    await query('UPDATE payments SET dispute_open=true WHERE order_id=$1', [o.id]);
    await due(o);
    await paymentSweep(stripe);
    assert.equal((await fill(o)).escrow_status, 'transferred');
  });

  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString('base64');
  const addProof = (o) => saveDeliveryProof(o.id, o.fills[0].id, 's1', { filename: 'transfer.png', contentType: 'image/png', data: PNG });
  async function dispute(session, status, id) {
    stripe.disputes.state.dp_test = { id: 'dp_test', status, amount: 4400 };
    await processWebhook({ id, type: status === 'needs_response' ? 'charge.dispute.created' : 'charge.dispute.closed', livemode: false,
      data: { object: { id: 'dp_test', object: 'dispute', charge: 'ch_' + session.payment_intent, amount: 4400 } } }, stripe);
  }
  async function paidOut() {
    const { order: o, session } = await checkout(); await markPaid(session); await deliver(o); await due(o);
    await paymentSweep(stripe);
    assert.equal(stripe.transfersMade.size, 1);
    return { o, session };
  }
  const transferRow = async (o) => (await query('SELECT * FROM seller_transfers WHERE fill_id=$1', [o.fills[0].id])).rows[0];
  const blocked = async () => (await query("SELECT payment_blocked_at FROM users WHERE id='buyer'")).rows[0].payment_blocked_at;

  it('stores only real proof files, from the seller, after the transfer', async () => {
    const { order: o, session } = await checkout(); await markPaid(session);
    await assert.rejects(addProof(o), { code: 'wrong_step' });
    await recordTransfer(o.id, o.fills[0].id, 's1', 'REF');
    await assert.rejects(saveDeliveryProof(o.id, o.fills[0].id, 's2', { contentType: 'image/png', data: PNG }), { code: 'forbidden' });
    await assert.rejects(saveDeliveryProof(o.id, o.fills[0].id, 's1', { contentType: 'image/png', data: Buffer.from('not an image').toString('base64') }), { code: 'bad_request' });
    await assert.rejects(saveDeliveryProof(o.id, o.fills[0].id, 's1', { contentType: 'image/png', data: Buffer.concat([Buffer.from(PNG, 'base64'), Buffer.alloc(4 * 1024 * 1024)]).toString('base64') }), { code: 'bad_request' });
    await addProof(o);
    assert.equal((await getOrder(o.id, 's1')).fills[0].hasProof, true);
  });

  it('keeps a paid seller with proof paid, submits evidence once, and covers a loss', async () => {
    const { o, session } = await paidOut();
    await addProof(o);
    await dispute(session, 'needs_response', 'evt_d1');
    await paymentSweep(stripe); await paymentSweep(stripe);
    assert.equal((await transferRow(o)).status, 'transferred');
    const evidence = stripe.calls.filter((c) => c[0] === 'evidence');
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0][1].submit, true);
    assert.match(evidence[0][1].evidence.uncategorized_file, /^file_/);
    assert.match(evidence[0][1].evidence.uncategorized_text, /PROVIDER-TRANSFER/);
    await dispute(session, 'lost', 'evt_d2');
    await paymentSweep(stripe);
    assert.equal((await transferRow(o)).status, 'transferred');
    assert.equal(stripe.transfersMade.size, 1);
    assert.ok(await blocked());
    await assert.rejects(buyAtPrice(order()), { code: 'forbidden' });
  });

  it('reverses a paid seller without proof, and repays them once if the dispute is won', async () => {
    const { o, session } = await paidOut();
    await dispute(session, 'needs_response', 'evt_d1');
    await paymentSweep(stripe);
    assert.equal((await transferRow(o)).status, 'reversed');
    await dispute(session, 'won', 'evt_d2');
    assert.equal((await payment(o.id)).status, 'succeeded');
    await paymentSweep(stripe); await paymentSweep(stripe);
    const row = await transferRow(o);
    assert.equal(row.status, 'transferred'); assert.equal(row.covered, false);
    assert.equal(stripe.transfersMade.size, 2);
    assert.equal([...stripe.transfersMade.values()].at(-1).source_transaction, undefined);
    assert.ok(await blocked());
  });

  it('leaves a seller without proof unpaid after a lost dispute, without blocking the buyer', async () => {
    const { order: o, session } = await checkout(); await markPaid(session); await deliver(o); await due(o);
    await dispute(session, 'needs_response', 'evt_d1');
    await dispute(session, 'lost', 'evt_d2');
    await paymentSweep(stripe);
    assert.equal(stripe.transfersMade.size, 0);
    assert.equal(await blocked(), null);
  });

  it('pays an unpaid seller with proof from Teezy after a lost dispute, exactly once', async () => {
    const { order: o, session } = await checkout(); await markPaid(session); await deliver(o); await addProof(o); await due(o);
    await dispute(session, 'needs_response', 'evt_d1');
    await dispute(session, 'lost', 'evt_d2');
    await paymentSweep(stripe); await paymentSweep(stripe);
    assert.equal(stripe.transfersMade.size, 1);
    const row = await transferRow(o);
    assert.equal(row.covered, true); assert.equal(row.amount_cents, 4000);
    await processWebhook({ id: 'evt_cover', type: 'transfer.created', livemode: false, data: { object: { id: row.stripe_transfer_id } } }, stripe);
  });

  it('waits for review when a reported delivery loses its dispute', async () => {
    const { order: o, session } = await checkout(); await markPaid(session);
    await recordTransfer(o.id, o.fills[0].id, 's1', 'REF'); await addProof(o);
    await reportProblem(o.id, o.fills[0].id, 'buyer', 'Ticket never arrived'); await due(o);
    await dispute(session, 'needs_response', 'evt_d1');
    await dispute(session, 'lost', 'evt_d2');
    await paymentSweep(stripe);
    assert.equal(stripe.transfersMade.size, 0);
  });

  it('reports the lost chargeback rate and warns at 0.5%', async () => {
    const { session } = await paidOut();
    await dispute(session, 'needs_response', 'evt_d1');
    await dispute(session, 'lost', 'evt_d2');
    const report = await disputeReport();
    assert.equal(report.paidOrders, 1); assert.equal(report.lost, 1); assert.equal(report.warning, true);
  });

  it('replays a dispute that arrived before its payment was saved', async () => {
    const { order: o, session } = await checkout();
    const event = { id: 'evt_early', type: 'charge.dispute.created', livemode: false,
      data: { object: { id: 'dp_test', object: 'dispute', charge: 'ch_' + session.payment_intent, amount: 4400 } } };
    await assert.rejects(processWebhook(event, stripe), { code: 'payment_not_recorded' });
    await markPaid(session);
    stripe.events.saved.evt_early = event;
    await paymentSweep(stripe);
    assert.equal((await payment(o.id)).status, 'succeeded'); // too recent to replay yet
    await query("UPDATE payment_webhooks SET received_at=now()-interval '2 minutes' WHERE event_id='evt_early'");
    await paymentSweep(stripe);
    assert.equal((await payment(o.id)).status, 'disputed');
    assert.ok((await query("SELECT processed_at FROM payment_webhooks WHERE event_id='evt_early'")).rows[0].processed_at);
  });

  it('ignores disputes on charges Teezy did not create', async () => {
    const retrieve = stripe.charges.retrieve;
    stripe.charges.retrieve = async (id) => ({ ...(await retrieve(id)), metadata: {} });
    await processWebhook({ id: 'evt_other', type: 'charge.dispute.created', livemode: false,
      data: { object: { id: 'dp_other', object: 'dispute', charge: 'ch_other', amount: 100 } } }, stripe);
    assert.ok((await query("SELECT processed_at FROM payment_webhooks WHERE event_id='evt_other'")).rows[0].processed_at);
  });

  it('stops a seller marking a ticket sent while a refund is pending or done', async () => {
    const { order: o, session } = await checkout(); await markPaid(session);
    await query("UPDATE payments SET status='refund_pending' WHERE order_id=$1", [o.id]);
    await assert.rejects(recordTransfer(o.id, o.fills[0].id, 's1', 'REF'), { code: 'refunded' });
    await query("UPDATE payments SET status='refunded' WHERE order_id=$1", [o.id]);
    await query("UPDATE orders SET status='cancelled' WHERE id=$1", [o.id]);
    await assert.rejects(recordTransfer(o.id, o.fills[0].id, 's1', 'REF'), { code: 'refunded', message: /refunded/ });
  });

  it('requires connected payouts before listing when Stripe is on', async () => {
    const eventId = (await query('SELECT id FROM events LIMIT 1')).rows[0].id;
    const input = { eventId, tier: 'ga', priceCents: 2000 };
    await assert.rejects(createListing('s3', input), { code: 'seller_not_ready' });
    await assert.rejects(createListing('s1', input), { code: 'seller_not_ready' }); // connected but not approved
    await query("UPDATE seller_accounts SET transfers_enabled=true WHERE user_id='s1'");
    assert.equal((await createListing('s1', input)).priceCents, 2000);
  });

  it('answers a malformed request as a client error, not a server failure', async () => {
    const app = buildApp({ stripe });
    try {
      const res = await app.inject({ method: 'POST', url: '/api/auth/email/start', headers: { 'content-type': 'application/json' } });
      assert.equal(res.statusCode, 400);
    } finally { await app.close(); }
  });

  it('pays each seller only for their confirmed fill on a split order', async () => {
    await addListing({ seller: 's1', price: 30 });
    await addListing({ seller: 's2', price: 40 });
    const { order: o } = await buyAtPrice(order({ qty: 2, allowSplit: true }));
    const result = await startCheckout(o.id, 'buyer', stripe);
    await markPaid(stripe.sessions.get(result.sessionId));
    const s1 = o.fills.find((f) => f.sellerId === 's1');
    const s2 = o.fills.find((f) => f.sellerId === 's2');
    await recordTransfer(o.id, s1.id, 's1', 'ONE'); await confirmTransfer(o.id, s1.id, 'buyer');
    await due(o); await paymentSweep(stripe);
    assert.deepEqual([...stripe.transfersMade.values()].map((t) => [t.destination, t.amount]), [['acct_s1', 3000]]);
    await recordTransfer(o.id, s2.id, 's2', 'TWO'); await confirmTransfer(o.id, s2.id, 'buyer');
    await paymentSweep(stripe);
    assert.equal(stripe.transfersMade.size, 2);
    assert.equal([...stripe.transfersMade.values()].reduce((n, t) => n + t.amount, 0), 7000);
  });
});
