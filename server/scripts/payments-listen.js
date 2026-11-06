// Local Stripe forwarding. Read credentials from .env, keep them out of command
// arguments and logs, and save the signing secret without printing it.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const shim = path.join(root, 'node_modules/@stripe/cli/bin/shim.js');
const settingsPath = path.join(root, '.env');
const stripeKey = process.env.STRIPE_SECRET_KEY;
if (!/^sk_test_/.test(stripeKey || '')) {
  console.error('Add a Stripe test secret key to .env before starting local payment forwarding.');
  process.exit(1);
}
const configDir = path.join(root, '.tools/stripe');
await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
const args = ['--config', path.join(configDir, 'config.toml'), '--color', 'off', 'listen'];
const childEnv = { ...process.env, STRIPE_API_KEY: stripeKey, STRIPE_DEVICE_NAME: 'teezy-local' };
const redact = (text) => text.replace(/(?:sk|pk|rk)_(?:test|live)_[A-Za-z0-9]+|whsec_[A-Za-z0-9]+/g, '[redacted]');

function capture(cliArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [shim, ...cliArgs], { cwd: root, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(output) : reject(new Error(redact(output.trim()) || 'Stripe forwarding setup failed')));
  });
}

try {
  const output = await capture([...args, '--print-secret']);
  const secret = output.match(/whsec_[A-Za-z0-9]+/)?.[0];
  if (!secret) throw new Error('Stripe did not return a webhook signing secret.');
  let settings = await fs.readFile(settingsPath, 'utf8');
  settings = /^STRIPE_WEBHOOK_SECRET=.*$/m.test(settings)
    ? settings.replace(/^STRIPE_WEBHOOK_SECRET=.*$/m, () => 'STRIPE_WEBHOOK_SECRET=' + secret)
    : settings.trimEnd() + '\nSTRIPE_WEBHOOK_SECRET=' + secret + '\n';
  await fs.writeFile(settingsPath, settings, { mode: 0o600 });
  await fs.chmod(settingsPath, 0o600);
  console.log('Stripe signing secret saved privately in .env. Restart Teezy if it was already running.');
  const port = Number(process.env.PORT || 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid local port.');
  const endpoint = `http://localhost:${port}/api/webhooks/stripe`;
  const child = spawn(process.execPath, [shim, ...args, '--forward-to', endpoint, '--forward-connect-to', endpoint,
    '--events', 'checkout.session.completed,checkout.session.async_payment_succeeded,account.updated,charge.refunded,refund.updated,charge.dispute.created,charge.dispute.closed,transfer.created'],
  { cwd: root, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  // Redact complete lines, so secrets split between output chunks cannot leak.
  let pending = '';
  const log = (chunk) => {
    pending += chunk.toString();
    const lines = pending.split(/\r?\n/); pending = lines.pop();
    for (const line of lines) if (line.trim()) console.log(redact(line));
  };
  child.stdout.on('data', log); child.stderr.on('data', log);
  child.on('error', (error) => { console.error(redact(error.message)); process.exitCode = 1; });
  child.on('close', (code) => { if (pending) console.log(redact(pending)); process.exitCode = code || 0; });
  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
} catch (error) {
  console.error(redact(error.message)); process.exitCode = 1;
}
