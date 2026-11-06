import { config } from '../config.js';
import { query, withTransaction, notify } from '../db.js';
import { enqueue, QUEUES } from '../jobs.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../errors.js';
import { stripeClient, stripeMode, paymentsEnabled } from './stripe.js';

const objectId = (value) => typeof value === 'string' ? value : value?.id;
const origin = () => new URL(config.publicUrl).origin;
const key = (operation, id) => ({ idempotencyKey: `teezy:${operation}:${id}:${stripeMode() ? 'live' : 'test'}` });

async function verifiedUser(id) {
  const { rows: [user] } = await query('SELECT * FROM users WHERE id = $1', [id]);
  if (!user?.email_verified_at) throw forbidden('verify your email before using Stripe payments');
  if (user.payment_blocked_at) throw forbidden('this account can no longer buy tickets; contact support');
  return user;
}
async function ledger(db, orderId, kind, amount, reference, fillId = null) {
  await db.query(`INSERT INTO payment_ledger (order_id, fill_id, kind, amount_cents, provider_reference)
    VALUES ($1,$2,$3,$4,$5) ON CONFLICT (provider_reference) DO NOTHING`, [orderId, fillId, kind, amount, reference]);
}
// Accounts v2: a seller can receive transfers once the recipient capability is active.
const ACCOUNT_INCLUDE = ['configuration.recipient', 'requirements'];
const retrieveAccount = (stripe, id) => stripe.v2.core.accounts.retrieve(id, { include: ACCOUNT_INCLUDE });
async function accountStatus(account, db = { query }) {
  const balance = account.configuration?.recipient?.capabilities?.stripe_balance;
  const ready = balance?.stripe_transfers?.status === 'active';
  const payoutsEnabled = balance?.payouts?.status === 'active';
  const due = (account.requirements?.entries || []).filter((entry) =>
    ['currently_due', 'past_due'].includes(entry.minimum_deadline?.status));
  await db.query(`UPDATE seller_accounts SET transfers_enabled=$2, payouts_enabled=$3, updated_at=now()
    WHERE stripe_account_id=$1`, [account.id, ready, payoutsEnabled]);
  return { connected: true, ready, transfersEnabled: ready, payoutsEnabled,
    detailsSubmitted: !due.length, requirements: due.map((entry) => entry.description) };
}
async function sellerAccount(userId, db = { query }) {
  const { rows: [row] } = await db.query('SELECT * FROM seller_accounts WHERE user_id=$1', [userId]);
  if (row && row.livemode !== stripeMode()) throw conflict('payment_mode_mismatch', 'use separate databases for Stripe test and live modes');
  return row;
}
export async function getSellerPayments(userId, stripe = stripeClient()) {
  const row = await sellerAccount(userId);
  if (!row) return { connected: false, ready: false };
  return accountStatus(await retrieveAccount(stripe, row.stripe_account_id));
}
export async function startSellerOnboarding(userId, stripe = stripeClient()) {
  const user = await verifiedUser(userId);
  const accountId = await withTransaction(async (db) => {
    await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId]);
    const existing = await sellerAccount(userId, db);
    if (existing) return existing.stripe_account_id;
    let account;
    try { account = await stripe.v2.core.accounts.create({
      contact_email: user.email, display_name: user.display_name || user.email, dashboard: 'express',
      identity: { country: 'us' },
      defaults: { responsibilities: { fees_collector: 'application', losses_collector: 'application' } },
      configuration: { recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } } },
      metadata: { teezyUserId: userId }, include: ACCOUNT_INCLUDE,
    }, key('seller-v2', userId)); }
    catch (error) {
      if (/losses.collector|loss.liability|platform must be activated|not signed up for Connect|platform questionnaire/i.test(error.message || '') ||
          /account_creation_(liability|identity_verification|losses_collector)|connect_profile_not_submitted|platform_registration_required|connect_identity_not_verified/.test(error.code || '')) {
        throw new AppError(503, 'stripe_platform_setup_required', 'The Teezy account owner must finish Stripe Connect platform verification and the payment-loss acknowledgement before sellers can connect payouts.');
      }
      // Other Stripe refusals keep their real reason in development; production stays generic.
      if (error.type?.startsWith('Stripe')) {
        console.error('Stripe seller setup failed:', error.message);
        throw new AppError(502, 'stripe_seller_setup_failed', config.isProduction ? 'Stripe could not set up seller payouts. Please try again or contact support.' : `Stripe refused seller setup: ${error.message}`);
      }
      throw error;
    }
    await db.query(`INSERT INTO seller_accounts (user_id,stripe_account_id,livemode) VALUES ($1,$2,$3)`, [userId, account.id, stripeMode()]);
    return account.id;
  });
  const link = await stripe.v2.core.accountLinks.create({ account: accountId, use_case: { type: 'account_onboarding',
    account_onboarding: { refresh_url: `${origin()}/?seller=refresh`, return_url: `${origin()}/?seller=return` } } });
  return { url: link.url };
}
export async function sellerDashboard(userId, stripe = stripeClient()) {
  const row = await sellerAccount(userId);
  if (!row) throw badRequest('connect your seller account first');
  return { url: (await stripe.accounts.createLoginLink(row.stripe_account_id)).url };
}

export async function startCheckout(orderId, buyerId, stripe = stripeClient()) {
  await verifiedUser(buyerId);
  // Persist the immutable Checkout request before contacting Stripe. A timeout or
  // process restart can retry the SAME idempotency key with identical parameters.
  await withTransaction(async (db) => {
    const { rows: [o] } = await db.query(`SELECT o.*,e.name FROM orders o JOIN events e ON e.id=o.event_id WHERE o.id=$1 FOR UPDATE OF o`, [orderId]);
    if (!o) throw notFound('order');
    if (o.buyer_id !== buyerId) throw forbidden('not your order');
    if (o.status !== 'pending_payment' || new Date(o.payment_expires_at) <= new Date()) throw conflict('not_payable', 'this reservation is no longer payable');
    const { rows: [existing] } = await db.query('SELECT * FROM payments WHERE order_id=$1', [orderId]);
    if (existing) {
      if (existing.livemode !== stripeMode()) throw conflict('payment_mode_mismatch', 'payment mode does not match this order');
      return;
    }
    const { rows: fills } = await db.query('SELECT DISTINCT seller_id FROM order_fills WHERE order_id=$1', [orderId]);
    for (const fill of fills) {
      const seller = await sellerAccount(fill.seller_id, db);
      if (!seller) throw conflict('seller_not_ready', 'the seller must connect payouts before this order can be paid');
      const status = await accountStatus(await retrieveAccount(stripe, seller.stripe_account_id), db);
      if (!status.ready) throw conflict('seller_not_ready', 'the seller must complete payout setup first');
    }
    // Stripe-hosted Checkout has a minimum 30-minute expiration window.
    const expires = new Date(Date.now() + 31 * 60 * 1000);
    await db.query(`INSERT INTO payments (order_id,amount_cents,description,livemode,checkout_expires_at)
      VALUES ($1,$2,$3,$4,$5)`, [orderId, o.total_cents, o.name, stripeMode(), expires]);
    await db.query('UPDATE orders SET payment_expires_at=$2 WHERE id=$1', [orderId, expires]);
    await enqueue(db, QUEUES.orderExpire, { orderId }, { startAfter: expires });
  });
  return withTransaction(async (db) => {
    const { rows: [o] } = await db.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [orderId]);
    const { rows: [p] } = await db.query('SELECT * FROM payments WHERE order_id=$1', [orderId]);
    if (o.status !== 'pending_payment' || new Date(p.checkout_expires_at) <= new Date()) throw conflict('not_payable', 'checkout has expired');
    const session = p.stripe_session_id ? await stripe.checkout.sessions.retrieve(p.stripe_session_id) : await stripe.checkout.sessions.create({
      mode: 'payment', client_reference_id: orderId,
      line_items: [{ price_data: { currency: 'usd', unit_amount: p.amount_cents, product_data: { name: p.description } }, quantity: 1 }],
      metadata: { orderId }, payment_intent_data: { metadata: { orderId }, transfer_group: `teezy_${orderId}` },
      expires_at: Math.floor(new Date(p.checkout_expires_at).getTime() / 1000),
      success_url: `${origin()}/?payment=return&order=${orderId}`, cancel_url: `${origin()}/?payment=cancel&order=${orderId}`,
    }, key('checkout', `${orderId}:${new Date(p.checkout_expires_at).getTime()}`));
    if (!p.stripe_session_id) await db.query('UPDATE payments SET stripe_session_id=$2,updated_at=now() WHERE order_id=$1', [orderId, session.id]);
    if (session.status !== 'open' || !session.url) throw conflict('checkout_closed', 'checkout is closed; refresh the order to see its payment status');
    return { url: session.url, sessionId: session.id };
  }).catch(async (error) => {
    // A 400 means Stripe created no session, unlike a timeout. Drop the unused request so
    // the buyer can retry with a fresh expiry, or the seats can expire normally.
    if (error.type !== 'StripeInvalidRequestError') throw error;
    await query("DELETE FROM payments WHERE order_id=$1 AND stripe_session_id IS NULL AND status='pending'", [orderId]);
    console.error('Stripe Checkout refused:', error.message);
    throw new AppError(502, 'checkout_failed', config.isProduction ? 'Stripe could not start checkout. Please try again.' : `Stripe refused checkout: ${error.message}`);
  });
}

async function applySession(session, stripe) {
  const orderId = session.client_reference_id;
  if (!orderId || session.metadata?.orderId !== orderId) return;
  await withTransaction(async (db) => {
    const { rows: [o] } = await db.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [orderId]);
    const { rows: [p] } = await db.query('SELECT * FROM payments WHERE order_id=$1', [orderId]);
    if (!o || !p || p.stripe_session_id && p.stripe_session_id !== session.id) throw conflict('unknown_checkout', 'checkout does not match the recorded order');
    if (session.livemode !== p.livemode || session.amount_total !== p.amount_cents || session.currency !== 'usd') throw conflict('payment_mismatch', 'payment amount, currency or mode does not match');
    // A valid provider event recovers a Checkout create whose response was lost.
    if (!p.stripe_session_id) await db.query('UPDATE payments SET stripe_session_id=$2 WHERE order_id=$1', [orderId, session.id]);
    if (session.payment_status !== 'paid') return;
    const intent = await stripe.paymentIntents.retrieve(objectId(session.payment_intent));
    if (intent.status !== 'succeeded' || intent.amount_received !== p.amount_cents || intent.currency !== 'usd' || intent.livemode !== p.livemode) throw conflict('payment_mismatch', 'payment has not succeeded for the expected amount');
    const chargeId = objectId(intent.latest_charge);
    if (!chargeId) throw conflict('payment_incomplete', 'payment charge is not available yet');
    await db.query(`UPDATE payments SET stripe_payment_intent_id=$2,stripe_charge_id=$3,updated_at=now() WHERE order_id=$1`, [orderId, intent.id, chargeId]);
    await ledger(db, orderId, 'charge', p.amount_cents, chargeId);
    if (!['pending', 'expired'].includes(p.status)) return;
    if (o.status !== 'pending_payment') {
      // Inventory already returned to the book: never resurrect an expired order.
      await db.query("UPDATE payments SET status='refund_pending' WHERE order_id=$1", [orderId]);
      return;
    }
    await db.query("UPDATE payments SET status='succeeded' WHERE order_id=$1", [orderId]);
    await db.query("UPDATE orders SET status='paid',paid_at=now(),updated_at=now() WHERE id=$1", [orderId]);
    await db.query("UPDATE order_fills SET escrow_status='held',updated_at=now() WHERE order_id=$1 AND escrow_status='awaiting_payment'", [orderId]);
    await notify(db, { type: 'order', orderId, userId: o.buyer_id });
    await notify(db, { type: 'book', eventId: o.event_id });
  });
}
export async function syncPayment(orderId, buyerId, stripe = stripeClient()) {
  const { rows: [p] } = await query(`SELECT p.*,o.buyer_id FROM payments p JOIN orders o ON o.id=p.order_id WHERE p.order_id=$1`, [orderId]);
  if (!p) throw notFound('payment');
  if (p.buyer_id !== buyerId) throw forbidden('not your payment');
  if (p.stripe_session_id) await applySession(await stripe.checkout.sessions.retrieve(p.stripe_session_id), stripe);
  return { received: true };
}

// Expire Stripe's checkout BEFORE returning inventory. A concurrent successful
// payment wins at Stripe and is reconciled instead of overselling the ticket.
export async function closeCheckoutForExpiry(orderId, stripe = stripeClient()) {
  const { rows: [p] } = await query('SELECT * FROM payments WHERE order_id=$1', [orderId]);
  if (!p) return;
  if (p.livemode !== stripeMode()) throw new Error('cannot expire checkout in a different Stripe mode');
  if (!p.stripe_session_id) throw new Error('checkout creation is unresolved; keep inventory reserved for recovery');
  let session = await stripe.checkout.sessions.retrieve(p.stripe_session_id);
  if (session.status === 'open') {
    try { session = await stripe.checkout.sessions.expire(session.id); }
    catch (err) { session = await stripe.checkout.sessions.retrieve(session.id); if (session.status === 'open') throw err; }
  }
  if (session.payment_status === 'paid') await applySession(session, stripe);
  else if (session.status !== 'expired') throw new Error('checkout is not safely expired');
}

export async function requestRefund(orderId, buyerId, stripe = stripeClient()) {
  // Only self-service before delivery. Support handles delivered/disputed orders.
  return withTransaction(async (db) => {
    const { rows: [o] } = await db.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [orderId]);
    if (!o) throw notFound('order');
    if (o.buyer_id !== buyerId) throw forbidden('not your order');
    const { rows: [p] } = await db.query('SELECT * FROM payments WHERE order_id=$1', [orderId]);
    if (!p?.stripe_payment_intent_id) throw badRequest('this order has no Stripe payment');
    if (p.status === 'refunded' || p.status === 'refund_pending') return { status: p.status };
    const { rows: delivered } = await db.query("SELECT id FROM order_fills WHERE order_id=$1 AND escrow_status NOT IN ('held','awaiting_payment')", [orderId]);
    if (p.status !== 'succeeded' || delivered.length) throw conflict('refund_needs_review', 'contact support for refunds after a ticket has been marked sent');
    await db.query("UPDATE payments SET status='refund_pending',updated_at=now() WHERE order_id=$1", [orderId]);
    return { status: 'refund_pending' };
  }).then(async (result) => { await finishRefund(orderId, stripe); return result; });
}

async function finishRefund(orderId, stripe) {
  await withTransaction(async (db) => {
    const { rows: [o] } = await db.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [orderId]);
    const { rows: [p] } = await db.query('SELECT * FROM payments WHERE order_id=$1', [orderId]);
    if (p?.status !== 'refund_pending') return;
    if (p.livemode !== stripeMode()) throw new Error('refund payment mode mismatch');
    let refund = await stripe.refunds.create({ payment_intent: p.stripe_payment_intent_id, amount: p.amount_cents }, key('refund', orderId));
    if (refund.status === 'pending') refund = await stripe.refunds.retrieve(refund.id);
    if (refund.status === 'failed' || refund.status === 'canceled') throw new Error('Stripe refund failed; manual review required');
    if (refund.status !== 'succeeded') return;
    await ledger(db, orderId, 'refund', -refund.amount, refund.id);
    await applyRefund(db, o, p, refund.amount);
  });
}
async function applyRefund(db, o, p, amount) {
  const full = amount >= p.amount_cents;
  await db.query(`UPDATE payments SET refunded_cents=GREATEST(refunded_cents,$2),status=$3,updated_at=now()
    WHERE order_id=$1`, [o.id, amount, full ? 'refunded' : 'review']);
  if (!full) return;
  // Refunded tickets are not automatically relisted: delivery may already have happened.
  await db.query("UPDATE order_fills SET escrow_status='refunded',updated_at=now() WHERE order_id=$1 AND escrow_status <> 'void'", [o.id]);
  if (o.status === 'paid') await db.query("UPDATE orders SET status='cancelled',updated_at=now() WHERE id=$1", [o.id]);
  await notify(db, { type: 'order', orderId: o.id, userId: o.buyer_id });
}

export async function processWebhook(event, stripe = stripeClient()) {
  if (event.livemode !== stripeMode()) {
    // Stripe also sends test Connect events to production URLs. Acknowledge them, or it keeps retrying.
    if (event.account && stripeMode()) return;
    throw badRequest('Stripe event mode does not match this environment');
  }
  await query(`INSERT INTO payment_webhooks(event_id,event_type) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [event.id, event.type]);
  const { rows: [record] } = await query('SELECT * FROM payment_webhooks WHERE event_id=$1', [event.id]);
  if (record.processed_at) return;
  const object = event.data.object;
  if (event.type === 'account.updated') {
    const { rows } = await query('SELECT user_id FROM seller_accounts WHERE stripe_account_id=$1 AND livemode=$2', [object.id, stripeMode()]);
    if (rows.length) await accountStatus(await retrieveAccount(stripe, object.id));
  } else if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    if (!event.account) await applySession(await stripe.checkout.sessions.retrieve(object.id), stripe);
  } else if (event.type === 'transfer.created' && !event.account) {
    const transfer = await stripe.transfers.retrieve(object.id);
    // Teezy-funded payouts have no source charge and are recorded by the worker.
    const fillId = transfer.metadata?.teezyPayout ? null : transfer.metadata?.fillId;
    if (fillId) await withTransaction(async (db) => {
      const { rows: [f] } = await db.query(`SELECT f.* FROM order_fills f JOIN orders o ON o.id=f.order_id WHERE f.id=$1 FOR UPDATE OF o`, [fillId]);
      if (!f || transfer.metadata.orderId !== f.order_id) throw badRequest('unknown transfer fill');
      const account = await sellerAccount(f.seller_id, db);
      const { rows: [p] } = await db.query('SELECT * FROM payments WHERE order_id=$1', [f.order_id]);
      if (!p || p.stripe_charge_id !== objectId(transfer.source_transaction) || transfer.currency !== 'usd' ||
          transfer.amount !== f.qty * f.price_cents || objectId(transfer.destination) !== account?.stripe_account_id) throw badRequest('transfer does not match the recorded seller');
      await db.query(`INSERT INTO seller_transfers(fill_id,seller_id,amount_cents,stripe_transfer_id,status,transferred_at)
        VALUES ($1,$2,$3,$4,'transferred',now()) ON CONFLICT(fill_id) DO UPDATE SET
        stripe_transfer_id=EXCLUDED.stripe_transfer_id,status=CASE WHEN seller_transfers.status='reversed' THEN 'reversed' ELSE 'transferred' END,
        transferred_at=coalesce(seller_transfers.transferred_at,now()),updated_at=now()`, [f.id, f.seller_id, transfer.amount, transfer.id]);
      await ledger(db, f.order_id, 'transfer', -transfer.amount, transfer.id, f.id);
      if (p.status === 'succeeded' && f.escrow_status === 'confirmed') await db.query("UPDATE order_fills SET escrow_status='released' WHERE id=$1", [f.id]);
    });
  } else if (event.type === 'charge.refunded' || event.type === 'charge.dispute.created' || event.type === 'charge.dispute.closed' || event.type === 'refund.updated') {
    if (!event.account) {
      const chargeId = object.object === 'charge' ? object.id : objectId(object.charge);
      // Retrieve current state, so delayed/out-of-order events cannot undo a refund.
      const charge = await stripe.charges.retrieve(chargeId);
      const refunds = charge.amount_refunded > 0 ? await stripe.refunds.list({ charge: chargeId, limit: 100 }) : { data: [] };
      const dispute = event.type.startsWith('charge.dispute.') ? await stripe.disputes.retrieve(object.id) : null;
      await withTransaction(async (db) => {
        const { rows: [p] } = await db.query('SELECT * FROM payments WHERE stripe_charge_id=$1', [chargeId]);
        if (!p) {
          if (!charge.metadata?.orderId) return; // not a Teezy charge
          throw conflict('payment_not_recorded', 'payment is not recorded yet; retry delivery');
        }
        const { rows: [o] } = await db.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [p.order_id]);
        if (charge.amount_refunded > 0) {
          await applyRefund(db, o, p, charge.amount_refunded);
          for (const refund of refunds.data) if (refund.status === 'succeeded') await ledger(db, o.id, 'refund', -refund.amount, refund.id);
        }
        if (dispute) await applyDispute(db, o, p, dispute);
      });
    }
  }
  await query('UPDATE payment_webhooks SET processed_at=now() WHERE event_id=$1', [event.id]);
}

async function transferSellerFill(fillId, stripe) {
  return withTransaction(async (db) => {
    const { rows: [f] } = await db.query(`SELECT f.*,o.id AS oid,e.starts_at FROM order_fills f
      JOIN orders o ON o.id=f.order_id JOIN events e ON e.id=o.event_id WHERE f.id=$1 FOR UPDATE OF o`, [fillId]);
    if (!f) return;
    const { rows: [p] } = await db.query('SELECT * FROM payments WHERE order_id=$1', [f.order_id]);
    if (!p || p.livemode !== stripeMode() || p.status !== 'succeeded' || p.refunded_cents || p.dispute_open || f.escrow_status !== 'confirmed' ||
        new Date(f.starts_at).getTime() + config.payoutDelayHours * 3600000 > Date.now()) return;
    const account = await sellerAccount(f.seller_id, db);
    if (!account || !(await accountStatus(await retrieveAccount(stripe, account.stripe_account_id), db)).ready) return;
    const amount = f.qty * f.price_cents;
    await db.query(`INSERT INTO seller_transfers(fill_id,seller_id,amount_cents) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [f.id, f.seller_id, amount]);
    const { rows: [existing] } = await db.query('SELECT * FROM seller_transfers WHERE fill_id=$1', [f.id]);
    if (existing.status !== 'pending') return;
    const transfer = await stripe.transfers.create({ amount, currency: 'usd', destination: account.stripe_account_id,
      source_transaction: p.stripe_charge_id, transfer_group: `teezy_${f.order_id}`, metadata: { orderId: f.order_id, fillId: f.id } }, key('transfer', f.id));
    await db.query("UPDATE seller_transfers SET stripe_transfer_id=$2,status='transferred',transferred_at=now(),updated_at=now() WHERE fill_id=$1", [f.id, transfer.id]);
    await db.query("UPDATE order_fills SET escrow_status='released',updated_at=now() WHERE id=$1", [f.id]);
    await ledger(db, f.order_id, 'transfer', -amount, transfer.id, f.id);
    await notify(db, { type: 'order', orderId: f.order_id, userId: f.seller_id });
  });
}
const hasProof = (db, fillId) => db.query('SELECT 1 FROM delivery_proofs WHERE fill_id=$1', [fillId]).then((r) => r.rows.length > 0);

// Stripe's current dispute state decides the outcome, so out-of-order events can't undo it.
async function applyDispute(db, o, p, dispute) {
  await ledger(db, o.id, 'dispute', -dispute.amount, dispute.id);
  const outcome = ['won', 'warning_closed'].includes(dispute.status) ? 'won' : dispute.status === 'lost' ? 'lost' : null;
  if (!outcome) {
    await db.query("UPDATE payments SET status='disputed',dispute_open=true,stripe_dispute_id=$2,updated_at=now() WHERE order_id=$1", [o.id, dispute.id]);
    return;
  }
  if (outcome === 'won') {
    await db.query(`UPDATE payments SET dispute_open=false,dispute_outcome='won',stripe_dispute_id=$2,updated_at=now(),
      status=CASE WHEN refunded_cents=0 THEN 'succeeded' WHEN refunded_cents>=amount_cents THEN 'refunded' ELSE 'review' END
      WHERE order_id=$1`, [o.id, dispute.id]);
    await ledger(db, o.id, 'dispute', dispute.amount, `${dispute.id}:won`);
  } else {
    await db.query(`UPDATE payments SET status='disputed',dispute_open=false,dispute_outcome='lost',stripe_dispute_id=$2,updated_at=now()
      WHERE order_id=$1`, [o.id, dispute.id]);
  }
  // A claim the bank rejected, or one lost against proof of delivery, counts as false.
  const { rows: [proof] } = await db.query(`SELECT 1 FROM delivery_proofs d JOIN order_fills f ON f.id=d.fill_id WHERE f.order_id=$1 LIMIT 1`, [o.id]);
  if (dispute.status === 'won' || (outcome === 'lost' && proof)) {
    await db.query(`UPDATE users SET payment_blocked_at=coalesce(payment_blocked_at,now()),payment_blocked_reason=coalesce(payment_blocked_reason,$2)
      WHERE id=$1`, [o.buyer_id, `chargeback ${dispute.id} ${dispute.status}`]);
  }
  await notify(db, { type: 'order', orderId: o.id, userId: o.buyer_id });
}

// Teezy's payout from its own balance: repaying a reversed seller after a win, or covering
// a seller with proof after a loss. The charge can't fund these, so no source_transaction.
async function platformPayout(fillId, reason, stripe) {
  await withTransaction(async (db) => {
    const { rows: [f] } = await db.query(`SELECT f.* FROM order_fills f JOIN orders o ON o.id=f.order_id WHERE f.id=$1 FOR UPDATE OF o`, [fillId]);
    const { rows: [p] } = await db.query('SELECT * FROM payments WHERE order_id=$1', [f.order_id]);
    const { rows: [paid] } = await db.query('SELECT * FROM seller_transfers WHERE fill_id=$1', [fillId]);
    if (p.livemode !== stripeMode() || paid?.status === 'transferred') return;
    if (reason === 'repay' ? !(paid?.status === 'reversed' && p.dispute_outcome === 'won' && p.status === 'succeeded')
      : !(p.dispute_outcome === 'lost' && !f.problem_reported_at && ['transferred', 'confirmed'].includes(f.escrow_status) && await hasProof(db, fillId))) return;
    const account = await sellerAccount(f.seller_id, db);
    if (!account || !(await accountStatus(await retrieveAccount(stripe, account.stripe_account_id), db)).ready) return;
    const amount = f.qty * f.price_cents;
    const transfer = await stripe.transfers.create({ amount, currency: 'usd', destination: account.stripe_account_id, transfer_group: `teezy_${f.order_id}`,
      metadata: { orderId: f.order_id, fillId: f.id, teezyPayout: reason } }, key(`transfer-${reason}`, f.id));
    await db.query(`INSERT INTO seller_transfers(fill_id,seller_id,amount_cents,stripe_transfer_id,status,transferred_at,covered)
      VALUES ($1,$2,$3,$4,'transferred',now(),$5) ON CONFLICT(fill_id) DO UPDATE SET stripe_transfer_id=EXCLUDED.stripe_transfer_id,
      status='transferred',transferred_at=now(),covered=EXCLUDED.covered,updated_at=now()`, [f.id, f.seller_id, amount, transfer.id, reason === 'cover']);
    await db.query("UPDATE order_fills SET escrow_status='released',updated_at=now() WHERE id=$1", [f.id]);
    await ledger(db, f.order_id, 'transfer', -amount, transfer.id, f.id);
    await notify(db, { type: 'order', orderId: f.order_id, userId: f.seller_id });
  });
}

// One dispute covers the whole charge, so a split order's proofs share these file fields.
const EVIDENCE_FILE_FIELDS = ['uncategorized_file', 'service_documentation', 'receipt', 'customer_communication'];
async function submitDisputeEvidence(orderId, stripe) {
  const { rows: [p] } = await query('SELECT * FROM payments WHERE order_id=$1', [orderId]);
  const dispute = await stripe.disputes.retrieve(p.stripe_dispute_id);
  if (!['needs_response', 'warning_needs_response'].includes(dispute.status)) {
    await query('UPDATE payments SET evidence_submitted_at=now() WHERE order_id=$1', [orderId]);
    return;
  }
  const { rows: fills } = await query(`SELECT f.id,f.qty,f.transfer_reference,f.transferred_at,f.confirmed_at,f.auto_confirmed,
      d.filename,d.data,e.name,e.starts_at,u.email,u.display_name
    FROM order_fills f JOIN delivery_proofs d ON d.fill_id=f.id JOIN orders o ON o.id=f.order_id
    JOIN events e ON e.id=o.event_id JOIN users u ON u.id=o.buyer_id WHERE f.order_id=$1 ORDER BY f.created_at LIMIT 4`, [orderId]);
  if (!fills.length) return;
  const evidence = { product_description: `Event ticket resale: ${fills[0].name}`, customer_email_address: fills[0].email,
    customer_name: fills[0].display_name, service_date: new Date(fills[0].starts_at).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }),
    uncategorized_text: fills.map((f) => `${f.qty} ticket(s) sent through the official ticketing service on ${new Date(f.transferred_at).toISOString()}, reference ${f.transfer_reference}. ` +
      (f.auto_confirmed ? 'The buyer did not report a problem before the deadline.' : f.confirmed_at ? `The buyer confirmed receipt on ${new Date(f.confirmed_at).toISOString()}.` : 'The buyer has not confirmed receipt.')).join(' ') };
  for (const [i, f] of fills.entries()) {
    const file = await stripe.files.create({ purpose: 'dispute_evidence', file: { data: f.data, name: f.filename, type: 'application/octet-stream' } }, key('evidence-file', f.id));
    evidence[EVIDENCE_FILE_FIELDS[i]] = file.id;
  }
  await stripe.disputes.update(dispute.id, { evidence, submit: true }, key('evidence', dispute.id));
  await query('UPDATE payments SET evidence_submitted_at=now() WHERE order_id=$1', [orderId]);
}

export async function disputeReport(days = 90) {
  const { rows: [r] } = await query(`SELECT count(*)::int AS paid_orders,
      count(*) FILTER (WHERE p.stripe_dispute_id IS NOT NULL)::int AS disputes,
      count(*) FILTER (WHERE p.dispute_outcome='lost')::int AS lost,
      count(*) FILTER (WHERE p.dispute_outcome='won')::int AS won,
      count(*) FILTER (WHERE p.dispute_open)::int AS open
    FROM payments p JOIN orders o ON o.id=p.order_id
    WHERE o.paid_at >= now() - $1 * interval '1 day' AND p.livemode=$2`, [days, stripeMode()]);
  const { rows: [c] } = await query(`SELECT coalesce(sum(amount_cents),0)::int AS cents FROM seller_transfers
    WHERE covered AND transferred_at >= now() - $1 * interval '1 day'`, [days]);
  const lostRate = r.paid_orders ? r.lost / r.paid_orders : 0;
  return { days, paidOrders: r.paid_orders, disputes: r.disputes, lost: r.lost, won: r.won, open: r.open,
    lostRate, coveredCents: c.cents, warning: lostRate >= 0.005 };
}

async function reverseSellerFill(fillId, stripe) {
  await withTransaction(async (db) => {
    const { rows: [f] } = await db.query(`SELECT f.* FROM order_fills f JOIN orders o ON o.id=f.order_id WHERE f.id=$1 FOR UPDATE OF o`, [fillId]);
    const { rows: [p] } = await db.query('SELECT * FROM payments WHERE order_id=$1', [f.order_id]);
    if (!['refunded','refund_pending','disputed','review'].includes(p.status)) return;
    if (p.status === 'disputed' && await hasProof(db, fillId)) return; // Teezy covers sellers with proof
    const { rows: [transfer] } = await db.query("SELECT * FROM seller_transfers WHERE fill_id=$1 AND status='transferred'", [fillId]);
    if (!transfer) return;
    const reversal = await stripe.transfers.createReversal(transfer.stripe_transfer_id, {}, key('reversal', fillId));
    await db.query("UPDATE seller_transfers SET stripe_reversal_id=$2,status='reversed',updated_at=now() WHERE fill_id=$1", [fillId, reversal.id]);
    await ledger(db, f.order_id, 'reversal', reversal.amount, reversal.id, fillId);
  });
}

// A silent buyer must not block the seller forever: once the report window closes,
// a delivery with no reported problem counts as received.
async function autoConfirmDeliveries() {
  const { rows } = await query(`UPDATE order_fills f SET escrow_status='confirmed', confirmed_at=clock_timestamp(),
      auto_confirmed=true, updated_at=clock_timestamp()
    FROM orders o, events e, payments p
    WHERE o.id=f.order_id AND e.id=o.event_id AND p.order_id=o.id AND f.escrow_status='transferred'
      AND f.problem_reported_at IS NULL AND o.status='paid' AND p.status='succeeded' AND NOT p.dispute_open
      AND p.livemode=$1 AND e.starts_at + $2 * interval '1 hour' <= now()
    RETURNING f.order_id, f.seller_id, o.buyer_id`, [stripeMode(), config.autoConfirmHours]);
  for (const r of rows) {
    await notify({ query }, { type: 'order', orderId: r.order_id, userId: r.buyer_id });
    await notify({ query }, { type: 'order', orderId: r.order_id, userId: r.seller_id });
  }
}

export async function paymentSweep(stripe = stripeClient()) {
  if (!paymentsEnabled()) return;
  const errors = [];
  const attempt = async (fn) => { try { await fn(); } catch (err) { errors.push(err); } };
  // Events can arrive out of order, such as a dispute before its payment is saved. Replay any
  // that failed from Stripe's copy, inside its 3-day retry window. Connected-account events
  // need their account to fetch, and live readiness checks already cover those.
  const { rows: stale } = await query(`SELECT event_id FROM payment_webhooks WHERE processed_at IS NULL AND event_type NOT LIKE 'account.%'
    AND received_at < now() - interval '1 minute' AND received_at > now() - interval '3 days'`);
  for (const r of stale) await attempt(async () => processWebhook(await stripe.events.retrieve(r.event_id), stripe));
  const { rows: refunds } = await query("SELECT order_id FROM payments WHERE status='refund_pending' AND livemode=$1", [stripeMode()]);
  for (const r of refunds) await attempt(() => finishRefund(r.order_id, stripe));
  const { rows: reversals } = await query(`SELECT t.fill_id FROM seller_transfers t JOIN order_fills f ON f.id=t.fill_id
    JOIN payments p ON p.order_id=f.order_id WHERE t.status='transferred' AND p.livemode=$1
    AND p.status IN ('refunded','refund_pending','disputed','review')
    AND NOT (p.status='disputed' AND EXISTS (SELECT 1 FROM delivery_proofs d WHERE d.fill_id=t.fill_id))`, [stripeMode()]);
  for (const r of reversals) await attempt(() => reverseSellerFill(r.fill_id, stripe));
  const { rows: evidence } = await query(`SELECT p.order_id FROM payments p WHERE p.dispute_open AND p.stripe_dispute_id IS NOT NULL
    AND p.evidence_submitted_at IS NULL AND p.livemode=$1 AND EXISTS (SELECT 1 FROM delivery_proofs d JOIN order_fills f ON f.id=d.fill_id WHERE f.order_id=p.order_id)`, [stripeMode()]);
  for (const r of evidence) await attempt(() => submitDisputeEvidence(r.order_id, stripe));
  const { rows: repay } = await query(`SELECT t.fill_id FROM seller_transfers t JOIN order_fills f ON f.id=t.fill_id JOIN payments p ON p.order_id=f.order_id
    WHERE t.status='reversed' AND p.dispute_outcome='won' AND p.status='succeeded' AND p.livemode=$1`, [stripeMode()]);
  for (const r of repay) await attempt(() => platformPayout(r.fill_id, 'repay', stripe));
  const { rows: cover } = await query(`SELECT f.id FROM order_fills f JOIN payments p ON p.order_id=f.order_id JOIN orders o ON o.id=f.order_id JOIN events e ON e.id=o.event_id
    JOIN delivery_proofs d ON d.fill_id=f.id WHERE p.dispute_outcome='lost' AND p.livemode=$1 AND f.problem_reported_at IS NULL
    AND f.escrow_status IN ('transferred','confirmed') AND e.starts_at + $2 * interval '1 hour' <= now()`, [stripeMode(), config.payoutDelayHours]);
  for (const r of cover) await attempt(() => platformPayout(r.id, 'cover', stripe));
  await attempt(autoConfirmDeliveries);
  const { rows: due } = await query(`SELECT f.id FROM order_fills f JOIN orders o ON o.id=f.order_id JOIN events e ON e.id=o.event_id
    JOIN payments p ON p.order_id=o.id WHERE f.escrow_status='confirmed' AND p.status='succeeded' AND p.livemode=$1
    AND e.starts_at + $2 * interval '1 hour' <= now()`, [stripeMode(), config.payoutDelayHours]);
  for (const r of due) await attempt(() => transferSellerFill(r.id, stripe));
  // A missed webhook must not strand reservations forever, including after API downtime.
  const { rows: expired } = await query(`SELECT p.order_id FROM payments p JOIN orders o ON o.id=p.order_id
    WHERE p.status='pending' AND p.livemode=$1 AND o.status='pending_payment' AND p.checkout_expires_at<=now()`, [stripeMode()]);
  const { expireOrder } = await import('./orders.js');
  for (const r of expired) await attempt(() => expireOrder(r.order_id, stripe));
  if (errors.length) throw new AggregateError(errors, 'payment reconciliation needs retry');
}

export async function paymentSummary(userId) {
  const { rows } = await query(`SELECT p.order_id,p.amount_cents,p.status,p.refunded_cents,p.dispute_open,p.livemode,
    p.stripe_session_id FROM payments p JOIN orders o ON o.id=p.order_id WHERE o.buyer_id=$1 ORDER BY o.created_at DESC LIMIT 100`, [userId]);
  const { rows: transfers } = await query(`SELECT t.fill_id,t.amount_cents,t.status,t.transferred_at FROM seller_transfers t WHERE t.seller_id=$1 ORDER BY t.updated_at DESC LIMIT 100`, [userId]);
  return { payments: rows, transfers };
}
