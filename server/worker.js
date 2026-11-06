import { QUEUES, startWorkers } from './jobs.js';
import { checkDesiredForListing } from './services/desiredTickets.js';
import { expireOrder } from './services/orders.js';
import { paymentSweep } from './services/payments.js';
import { paymentsEnabled } from './services/stripe.js';

export const handlers = {
  [QUEUES.listingChanged]: (data) => checkDesiredForListing(data),
  [QUEUES.orderExpire]: (data) => expireOrder(data.orderId),
  [QUEUES.payments]: () => paymentsEnabled() ? paymentSweep() : undefined,
};

export function startWorker(options) {
  return startWorkers(handlers, options);
}
