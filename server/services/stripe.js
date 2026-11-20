import Stripe from 'stripe';
import { config } from '../config.js';
import { AppError } from '../errors.js';

let cachedKey, cachedClient;
export function stripeMode() {
  return /^(sk|rk)_live_/.test(config.stripeSecretKey);
}

export function paymentsEnabled() {
  return config.paymentProvider === 'stripe' && !!config.stripeSecretKey && !!config.stripeWebhookSecret;
}

export function stripeClient() {
  if (!paymentsEnabled()) throw new AppError(503, 'payments_unavailable', 'Stripe payments are not configured yet');
  if (!/^(sk|rk)_(test|live)_/.test(config.stripeSecretKey)) throw new Error('invalid Stripe key configuration');
  if (stripeMode() && !config.allowLivePayments) throw new AppError(503, 'live_payments_disabled', 'Live payments have not been enabled');
  if (!Number.isFinite(config.payoutDelayHours) || config.payoutDelayHours < 0) throw new Error('PAYOUT_DELAY_HOURS must be zero or greater');
  const url = new URL(config.publicUrl);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) {
    throw new Error('PUBLIC_URL must be an HTTPS origin (HTTP localhost is allowed for testing)');
  }
  if (stripeMode() && url.protocol !== 'https:') throw new Error('live payments require an HTTPS PUBLIC_URL');
  if (stripeMode() && !config.stripeConnectWebhookSecret) throw new Error('live payments require STRIPE_CONNECT_WEBHOOK_SECRET');
  if (cachedKey !== config.stripeSecretKey) {
    cachedKey = config.stripeSecretKey;
    cachedClient = new Stripe(cachedKey, { maxNetworkRetries: 2, timeout: 15000 });
  }
  return cachedClient;
}

export function paymentRuntime() {
  return {
    demoPayments: config.paymentProvider === 'demo' && !config.isProduction,
    stripePayments: paymentsEnabled() && (!stripeMode() || config.allowLivePayments),
    paymentMode: config.paymentProvider === 'stripe' ? (stripeMode() ? 'live' : 'test') : 'demo',
    payoutDelayHours: config.payoutDelayHours,
    autoConfirmHours: config.autoConfirmHours,
    // Publishable keys are meant for browsers. Only shared when it matches the secret key's mode.
    stripePublishableKey: config.stripePublishableKey.startsWith(stripeMode() ? 'pk_live_' : 'pk_test_') ? config.stripePublishableKey : '',
  };
}
