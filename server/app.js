import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import { query } from './db.js';
import { AppError, badRequest, notFound, requireInt } from './errors.js';
import { subscribe } from './realtime.js';
import { buyAtPrice, getOrder, advanceEscrow } from './services/orders.js';
import { createListing, updateListing } from './services/listings.js';
import { getPriceData } from './services/priceData.js';
import { listDesired, createDesired, updateDesired, deleteDesired } from './services/desiredTickets.js';
import { registerPushToken, listNotifications } from './services/push.js';
import { simulateMarketMove } from './services/devSim.js';
import { startEmailLogin, verifyEmailLogin, userIdForSession, endSession } from './services/auth.js';

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const DESIGN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'design-reference');
export const DEMO_USER = 'mia';
const SESSION_COOKIE = 'teezy_session';

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function sessionCookie(token, maxAgeSeconds) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}` +
    (config.isProduction ? '; Secure' : '');
}

// Who is calling: the email-verified session if there is one. Outside production, tests
// and curl may also pass x-user-id (or ?as=), and signed-out calls act as the demo user.
async function resolveUser(req) {
  const fromSession = await userIdForSession(readCookie(req, SESSION_COOKIE));
  if (fromSession) return { id: fromSession, signedIn: true };
  if (config.isProduction) return null;
  const id = req.headers['x-user-id'] || req.query?.as;
  return { id: id ? String(id) : DEMO_USER, signedIn: false };
}

function userId(req) {
  if (!req.caller) throw new AppError(401, 'unauthenticated', 'sign in required');
  return req.caller.id;
}

const bool = (v) => v === true || v === 'true' || v === '1';

export function buildApp({ logger = false } = {}) {
  const app = Fastify({ logger });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: err.code, message: err.message });
    if (err.code === '23503') return reply.code(400).send({ error: 'bad_reference', message: 'unknown event, user or listing' });
    if (err.validation) return reply.code(400).send({ error: 'bad_request', message: err.message });
    req.log.error(err);
    return reply.code(500).send({ error: 'internal', message: 'something went wrong' });
  });

  app.register(fastifyStatic, { root: WEB_DIR });
  if (!config.isProduction) {
    // The redesign mocks, rendered as a gallery (design-reference/index.html).
    app.register(fastifyStatic, { root: DESIGN_DIR, prefix: '/design/', decorateReply: false });
  }

  app.addHook('preHandler', async (req) => {
    if (req.url.startsWith('/api/')) req.caller = await resolveUser(req);
  });

  /* ---------- sign-in: any email, verified with a 6-digit code ---------- */
  app.post('/api/auth/email/start', async (req) => {
    const { email, devCode } = await startEmailLogin(req.body?.email);
    return { sent: true, email, devCode };
  });

  app.post('/api/auth/email/verify', async (req, reply) => {
    const { token, user } = await verifyEmailLogin(req.body?.email, req.body?.code);
    reply.header('set-cookie', sessionCookie(token, config.sessionTtlDays * 24 * 60 * 60));
    return { user };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    await endSession(readCookie(req, SESSION_COOKIE));
    reply.header('set-cookie', sessionCookie('', 0));
    return reply.code(204).send();
  });

  /* ---------- profile ---------- */
  app.get('/api/me', async (req) => {
    const { rows: [u] } = await query('SELECT * FROM users WHERE id = $1', [userId(req)]);
    if (!u) throw notFound('user');
    return {
      id: u.id,
      displayName: u.display_name,
      email: u.email,
      emailVerified: !!u.email_verified_at,
      signedIn: req.caller.signedIn,
      rating: u.rating,
      maxBudgetCents: u.max_budget_cents,
    };
  });

  app.patch('/api/me', async (req) => {
    const v = req.body?.maxBudgetCents;
    const budget = v == null ? null : requireInt(v, 'maxBudgetCents', { min: 1 });
    const { rows: [u] } = await query(
      'UPDATE users SET max_budget_cents = $2 WHERE id = $1 RETURNING id, max_budget_cents',
      [userId(req), budget],
    );
    if (!u) throw notFound('user');
    return { id: u.id, maxBudgetCents: u.max_budget_cents };
  });

  /* ---------- events and the price slider ---------- */
  app.get('/api/events', async () => {
    const { rows } = await query(`
      SELECT e.*, array_remove(array_agg(DISTINCT l.tier), NULL) AS tiers
      FROM events e LEFT JOIN listings l ON l.event_id = e.id AND l.status = 'active'
      GROUP BY e.id ORDER BY e.starts_at`);
    return rows.map((e) => ({ id: e.id, name: e.name, venue: e.venue, startsAt: e.starts_at, tiers: e.tiers }));
  });

  app.get('/api/events/:eventId/price-data', async (req) =>
    getPriceData({
      eventId: req.params.eventId,
      tier: req.query.tier,
      qty: req.query.qty ?? 1,
      allowSplit: bool(req.query.split),
      buyerId: userId(req),
    }));

  /* ---------- buying ---------- */
  app.post('/api/orders', async (req, reply) => {
    const b = req.body || {};
    const result = await buyAtPrice({ ...b, buyerId: userId(req) });
    if (result.matched) return reply.code(201).send(result);
    // No seller at or under the price: offer to turn it into a Desired Ticket alert.
    return {
      ...result,
      suggestedAlert: { eventId: b.eventId, tier: b.tier ?? 'any', qty: b.qty ?? 1, maxPriceCents: b.maxPriceCents },
    };
  });

  app.get('/api/orders/:id', async (req) => getOrder(req.params.id, userId(req)));

  app.post('/api/orders/:id/:step', async (req) => {
    const { step } = req.params;
    if (!['pay', 'transfer', 'confirm', 'release'].includes(step)) throw notFound('route');
    if ((step === 'transfer' || step === 'release') && config.isProduction) {
      throw badRequest(`${step} is done by the seller or the payout job, not the buyer`);
    }
    return advanceEscrow(req.params.id, userId(req), step);
  });

  /* ---------- selling ---------- */
  app.post('/api/listings', async (req, reply) => reply.code(201).send(await createListing(userId(req), req.body || {})));
  app.patch('/api/listings/:id', async (req) => updateListing(req.params.id, userId(req), req.body || {}));

  /* ---------- desired tickets ---------- */
  app.get('/api/desired-tickets', async (req) => listDesired(userId(req)));
  app.post('/api/desired-tickets', async (req, reply) => reply.code(201).send(await createDesired(userId(req), req.body || {})));
  app.patch('/api/desired-tickets/:id', async (req) => updateDesired(userId(req), req.params.id, req.body || {}));
  app.delete('/api/desired-tickets/:id', async (req, reply) => {
    await deleteDesired(userId(req), req.params.id);
    return reply.code(204).send();
  });

  /* ---------- notifications ---------- */
  app.post('/api/push-tokens', async (req, reply) => {
    const { token, platform } = req.body || {};
    if (!token || !['ios', 'android', 'web'].includes(platform)) throw badRequest('token and platform (ios, android, web) are required');
    await registerPushToken(userId(req), { token, platform });
    return reply.code(204).send();
  });

  app.get('/api/notifications', async (req) => listNotifications(userId(req)));

  // Live book changes (refresh the slider) and dev push notifications.
  app.get('/api/stream', (req, reply) => {
    const uid = userId(req);
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    reply.raw.write(': connected\n\n');
    const unsubscribe = subscribe(uid, (event) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`));
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25000);
    req.raw.on('close', () => { clearInterval(ping); unsubscribe(); });
  });

  /* ---------- demo only ---------- */
  if (!config.isProduction) {
    // Another seller lists or reprices near a desired ticket, through the real pipeline.
    app.post('/api/dev/market-move', async (req) => simulateMarketMove(userId(req), req.body?.desiredTicketId));
  }

  return app;
}
