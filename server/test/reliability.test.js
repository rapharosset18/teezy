import { describe, it, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../config.js';
import { query } from '../db.js';
import { reportError } from '../alerts.js';
import { startRealtime, stopRealtime, subscribe } from '../realtime.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('failure reporting', () => {
  let sent, realFetch, realError;
  beforeEach(() => {
    sent = []; realFetch = globalThis.fetch; realError = console.error;
    console.error = () => {};
    globalThis.fetch = async (url, options) => { sent.push(JSON.parse(options.body).text); return { ok: true }; };
    config.alertWebhookUrl = 'https://alerts.example/hook';
  });
  afterEach(() => { globalThis.fetch = realFetch; console.error = realError; config.alertWebhookUrl = ''; });

  it('sends each distinct failure once an hour, with secrets removed', async () => {
    const failure = new Error('bad key sk_test_abc123 rejected ' + Date.now());
    await reportError('job payments', failure);
    await reportError('job payments', failure);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /job payments/);
    assert.doesNotMatch(sent[0], /sk_test_abc123/);
  });

  it('includes the reasons inside a grouped job failure', async () => {
    await reportError('job grouped', new AggregateError([new Error('first reason'), new Error('second reason')], 'needs retry'));
    assert.match(sent[0], /first reason.*second reason/);
  });

  it('only logs when no alert webhook is set', async () => {
    config.alertWebhookUrl = '';
    await reportError('job quiet', new Error('quiet'));
    assert.equal(sent.length, 0);
  });
});

describe('realtime connection', () => {
  afterEach(() => stopRealtime());

  it('reconnects after the database drops it, and keeps delivering events', async () => {
    await startRealtime();
    const seen = [];
    const unsubscribe = subscribe('u1', (event) => seen.push(event));
    const log = console.log, error = console.error;
    console.log = () => {}; console.error = () => {};
    try {
      await query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query = 'LISTEN teezy' AND pid <> pg_backend_pid()");
      for (let i = 0; i < 40 && !seen.length; i++) {
        await wait(100);
        await query("SELECT pg_notify('teezy', $1)", [JSON.stringify({ type: 'ping' })]);
      }
    } finally { console.log = log; console.error = error; unsubscribe(); }
    assert.equal(seen[0]?.type, 'ping');
  });
});
