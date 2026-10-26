import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { query } from '../db.js';
import { config } from '../config.js';
import { buildApp } from '../app.js';
import { resetDb } from './helpers.js';

let app;

async function start(email) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/email/start', payload: { email } });
  return res;
}

async function verify(email, code) {
  return app.inject({ method: 'POST', url: '/api/auth/email/verify', payload: { email, code } });
}

const cookieFrom = (res) => res.headers['set-cookie'].split(';')[0];

describe('email sign-in', () => {
  beforeEach(async () => { await resetDb(); app = buildApp(); });
  afterEach(() => app.close());

  it('accepts any email domain, not just schools', async () => {
    for (const email of ['sam@gmail.com', 'ana@ucla.edu', 'leo@company.co.uk']) {
      const res = await start(email);
      assert.equal(res.statusCode, 200, email);
      assert.match(res.json().devCode, /^\d{6}$/);
    }
  });

  it('rejects malformed emails', async () => {
    assert.equal((await start('not-an-email')).statusCode, 400);
  });

  it('a correct code creates the account, verifies the email and signs in', async () => {
    const { devCode } = (await start('  Sam.Lee@Gmail.com ')).json();
    const res = await verify('sam.lee@gmail.com', devCode);
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().user.email, 'sam.lee@gmail.com');
    assert.equal(res.json().user.displayName, 'Sam Lee');
    assert.match(res.headers['set-cookie'], /HttpOnly/);

    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: cookieFrom(res) } });
    assert.equal(me.json().email, 'sam.lee@gmail.com');
    assert.equal(me.json().signedIn, true);
    assert.equal(me.json().emailVerified, true);
  });

  it('signing in again with the same email reuses the account', async () => {
    const first = await verify('sam@gmail.com', (await start('sam@gmail.com')).json().devCode);
    const second = await verify('sam@gmail.com', (await start('sam@gmail.com')).json().devCode);
    assert.equal(first.json().user.id, second.json().user.id);
  });

  it('a code works once', async () => {
    const { devCode } = (await start('sam@gmail.com')).json();
    assert.equal((await verify('sam@gmail.com', devCode)).statusCode, 200);
    assert.equal((await verify('sam@gmail.com', devCode)).json().error, 'invalid_code');
  });

  it('wrong guesses are counted and the code dies after 5', async () => {
    const { devCode } = (await start('sam@gmail.com')).json();
    const wrong = devCode === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) assert.equal((await verify('sam@gmail.com', wrong)).statusCode, 400);
    assert.equal((await verify('sam@gmail.com', devCode)).json().error, 'invalid_code');
  });

  it('expired codes are rejected', async () => {
    const { devCode } = (await start('sam@gmail.com')).json();
    await query(`UPDATE email_login_codes SET expires_at = now() - interval '1 second'`);
    assert.equal((await verify('sam@gmail.com', devCode)).json().error, 'invalid_code');
  });

  it('limits how many codes one email can request per hour', async () => {
    for (let i = 0; i < config.loginCodesPerHour; i++) assert.equal((await start('sam@gmail.com')).statusCode, 200);
    assert.equal((await start('sam@gmail.com')).statusCode, 429);
  });

  it('logout ends the session', async () => {
    const res = await verify('sam@gmail.com', (await start('sam@gmail.com')).json().devCode);
    const cookie = cookieFrom(res);
    await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    // With the session gone, the dev fallback identity (x-user-id) applies again.
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie, 'x-user-id': 'buyer' } });
    assert.equal(me.json().id, 'buyer');
    assert.equal(me.json().signedIn, false);
  });

  it('in production, signed-out calls are refused and the code is never returned', async () => {
    config.isProduction = true;
    try {
      assert.equal((await app.inject({ method: 'GET', url: '/api/me' })).statusCode, 401);
      assert.equal((await start('sam@gmail.com')).json().devCode, undefined);
    } finally {
      config.isProduction = false;
    }
  });
});
