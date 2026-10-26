import { QUEUES, startWorkers } from './jobs.js';
import { checkDesiredForListing } from './services/desiredTickets.js';
import { expireOrder } from './services/orders.js';

export const handlers = {
  [QUEUES.listingChanged]: (data) => checkDesiredForListing(data),
  [QUEUES.orderExpire]: (data) => expireOrder(data.orderId),
};

export function startWorker(options) {
  return startWorkers(handlers, options);
}
