// One place for failures someone needs to know about. Everything is logged. If
// ALERT_WEBHOOK_URL is set (Slack-compatible), each distinct failure also sends a message,
// at most once an hour, because the payment job retries every minute.
import { config } from './config.js';

const ALERT_INTERVAL_MS = 60 * 60 * 1000;
const lastSent = new Map();
const redact = (text) => String(text).replace(/\b(sk|rk|whsec)_[A-Za-z0-9_*]+/g, '[redacted]');
const describe = (err) => redact(err?.errors?.length ? `${err.message}: ${err.errors.map((e) => e.message).join('; ')}` : err?.message ?? err);

export async function reportError(context, err) {
  console.error(`[error] ${context}:`, err);
  if (!config.alertWebhookUrl) return;
  const text = `Teezy: ${context}: ${describe(err)}`.slice(0, 1000);
  if (Date.now() - (lastSent.get(text) ?? 0) < ALERT_INTERVAL_MS) return;
  lastSent.set(text, Date.now());
  try {
    await fetch(config.alertWebhookUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }), signal: AbortSignal.timeout(5000) });
  } catch (sendError) {
    console.error('[error] alert could not be sent:', sendError.message);
  }
}
