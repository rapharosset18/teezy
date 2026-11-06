// Chargeback rate over the last 90 days. Teezy's cover promise needs review near 0.5% lost.
//   npm run payments:report
import { disputeReport } from '../services/payments.js';
import { closePool } from '../db.js';

const r = await disputeReport();
console.log(`Last ${r.days} days: ${r.paidOrders} paid orders, ${r.disputes} disputes, ${r.lost} lost, ${r.won} won, ${r.open} open`);
console.log(`Lost rate: ${(r.lostRate * 100).toFixed(2)}% · Teezy-funded payouts: $${(r.coveredCents / 100).toFixed(2)}`);
if (r.warning) console.log('WARNING: lost chargebacks have reached 0.5%. Review the seller cover promise.');
await closePool();
