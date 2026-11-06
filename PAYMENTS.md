# Teezy payments setup

The Stripe integration is implemented. Real Stripe sandbox and live transactions
still require your own Stripe account and credentials. Automated tests use a fake
Stripe client and the real Stripe SDK's signature verification; they do not prove
that a particular Stripe account has been approved or configured correctly.

## What is implemented

- Stripe-hosted card checkout. Teezy stores provider IDs, not card numbers.
- Stripe-hosted seller onboarding using Accounts v2 recipient accounts and an
  Express dashboard. The initial seller country is the United States.
- Separate platform charges and seller transfers. The buyer pays the ticket subtotal
  plus 10%; the seller receives the ticket subtotal. Teezy pays Stripe fees.
- Verified email and a real session are required for Stripe checkout and onboarding.
- Checkout requests and transfers use stable provider idempotency keys.
- Verified raw-body webhooks, durable event receipts, an operation ledger, and retries.
- Card payment is captured at checkout. Seller transfers wait for buyer receipt
  confirmation AND at least `PAYOUT_DELAY_HOURS` after the event's **start time**.
  Default: 24 hours. This is a scheduling approximation, not a gate scan or actual end time.
- If the buyer neither confirms nor reports a problem by `AUTO_CONFIRM_HOURS` after the
  event's start (default 24), the delivery confirms automatically. A reported problem
  stops auto-confirmation and payout until someone reviews it; there's no support tool yet.
- Seller transfers go to the seller's Stripe balance. Stripe then pays their bank on
  its payout schedule. Teezy's "sent to Stripe" status does not mean the bank received it.
- Buyer self-service full refunds before any ticket in the order is marked sent.
  Refunded tickets are not automatically relisted.
- Refunds after delivery need support review. Issue those through the Stripe Dashboard;
  webhook handling freezes the order and the worker reverses seller transfers.
- Partial refunds freeze transfers for manual review.
- Disputes freeze unpaid transfers. Sellers can upload proof of delivery (PNG, JPEG or PDF,
  up to 4 MB), and the worker sends it to Stripe as dispute evidence.
  - **Paid seller with proof:** keeps the money while the dispute runs.
  - **Paid seller without proof:** the transfer is reversed.
  - **Dispute won:** normal payouts resume, and reversed sellers are repaid from Teezy's balance.
  - **Dispute lost, seller has proof:** Teezy covers it, including paying unpaid sellers from its
    own balance. Fills with a reported problem wait for manual review.
  - **Dispute lost, no proof:** the seller isn't paid, or stays reversed.
- A buyer is blocked from buying after a dispute Teezy wins, or a loss against proof. Unblock
  by clearing `users.payment_blocked_at`. Lost disputes can include real card fraud.
- `npm run payments:report` shows the 90-day lost-chargeback rate and warns at 0.5%.
- Sellers must have payouts connected before listing, and can't mark a refunded order sent.
- Server and background job failures are logged. Set `ALERT_WEBHOOK_URL` to a Slack-compatible
  webhook to also get alerts, at most once an hour for each distinct failure.
- Stripe can send a dispute before its payment is saved. The worker replays unprocessed events
  from Stripe's copy for 3 days, except connected-account events.
- Sandbox outcomes need `uncategorized_text` to equal exactly `winning_evidence` or `losing_evidence`,
  so Teezy's automatic evidence stays under review there. Use the not-received card `4000 0000 0000 2685`.

This is delayed payment distribution, not an escrow service.

## Connect your Stripe sandbox

1. Sign in to Stripe and configure Connect for your Teezy platform. Use a sandbox/test
   environment. Configure branding, seller bank collection, and US seller onboarding.
2. Copy `.env.example` to `.env`. Fill in your **test** secret key locally as
   `STRIPE_SECRET_KEY`. Never send keys in chat or commit `.env`.
3. Run the bundled Stripe listener (the official CLI is a development dependency):

   ```sh
   npm run payments:listen
   ```

4. The listener uses the saved test key and writes `STRIPE_WEBHOOK_SECRET` into `.env`
   automatically without displaying secrets. Keep this terminal running for local webhooks.
5. Keep `PAYMENT_PROVIDER=stripe`, `ALLOW_LIVE_PAYMENTS=false`, and
   `PUBLIC_URL=http://localhost:3001`. Restart Teezy with `npm run dev` after changing
   `.env`. The development command loads `.env` automatically. If no database is already
   running, remove `DATABASE_URL` from `.env` to let Teezy start its embedded database.
6. In Teezy, sign in as a seller and use **Account → Payments and payouts → Connect
   seller payouts**. Complete Stripe's test onboarding. Teezy checks actual account
   readiness when you return; a return URL alone does not verify the seller.
7. Publish a ticket. Sign out and sign in with a different buyer email (or use a separate
   browser profile), choose that listing, and continue to Stripe checkout.
8. Use Stripe test card `4242 4242 4242 4242`, a future expiry, and any three-digit CVC.
   For a decline, use `4000 0000 0000 0002`. Never enter real card details in test mode.
9. Return to Teezy. Payment is marked paid only after a signed webhook or a server-side
   provider status check, regardless of the URL's success/cancel parameters.
10. As seller, mark the official transfer sent with a practice reference. As buyer,
    confirm receipt. Verify the two states in My Tickets.

If Stripe refuses to create a seller because the platform is the losses collector,
the account owner must finish the [Connect platform profile](https://dashboard.stripe.com/settings/connect/platform-profile),
including verification and the loss-liability acknowledgement required for separate
charges and transfers. The app reports this as a platform setup requirement. Do not
switch to Stripe-managed losses just to bypass the error: that configuration generally
requires direct charges and changes Teezy's payment/payout model.

The local `/transfer-test.html` tester continues to use simulated payments and cannot
send funds through Stripe. Its fixture accounts are not verified-email Stripe sellers.

## Verify refunds and seller transfers

- Before recording delivery, use **View order → Request full refund before delivery**.
  Refresh the order and verify the refund in Stripe. Retry the request to confirm that
  only one refund exists.
- To exercise seller transfers, use a dedicated sandbox event whose start time is in
  the past after the order is created, and a test-only `PAYOUT_DELAY_HOURS=0`. The worker
  checks once per minute. In normal operation, leave the 24-hour delay in place.
- Check **Payments and payouts** for the transfer amount and open the Stripe dashboard
  to see its separate bank-payout state. A Stripe transfer test is not a bank deposit.
- Retry webhook deliveries from Stripe and verify one ledger entry per provider
  operation. Full-order refund and transfer idempotency are covered by automated tests.
- Never use the same database for Stripe sandbox and live mode. Existing payment and
  seller account records enforce their mode; `npm run dev -- --reset` refuses to remove
  Stripe payment records.

## Webhook endpoint

`POST /api/webhooks/stripe`

Subscribe the platform endpoint to:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `charge.refunded`
- `refund.updated`
- `charge.dispute.created`
- `charge.dispute.closed`
- `transfer.created`

For connected accounts, subscribe to `account.updated` as well. The SDK is pinned to
Stripe 23.0.1, which defaults to API version `2026-09-30.endive`. Configure the endpoint's
event version to match the SDK and review that setting when updating Stripe.

Production needs two Stripe webhook endpoints pointing at this same URL, because Stripe
scopes each one to either **Your account** or **Connected accounts**: the platform events
above on the first, and `account.updated` on the second. Put their signing secrets in
`STRIPE_WEBHOOK_SECRET` and `STRIPE_CONNECT_WEBHOOK_SECRET`; live payments refuse to start
without both. The CLI's one secret covers both scopes and is only for local forwarding.
Stripe also sends test Connect events to production URLs; Teezy acknowledges and ignores them.

## Failure handling and operational limits

- Unpaid Stripe sessions are closed at the provider before inventory is returned.
  A payment that wins the expiry race is accepted; a genuinely late payment on already
  restored inventory is refunded instead of resurrecting the order.
- The background worker retries pending refunds, seller transfers, reversals, and expired
  reservations. Monitor worker errors; failed reversals require available seller funds
  and may need support intervention.
- A signed payment or transfer webhook can recover a provider operation whose HTTP
  response was lost before Teezy saved its provider ID. If Checkout creation remains
  unresolved and no webhook arrives, inventory stays reserved for manual reconciliation
  rather than risking a second sale. Inspect the provider before releasing those seats.
- No automatic payout is made for the old simulated-payment orders.
- Support controls, dispute-resolution workflows, alerts, deployment and backups remain
  separate launch work. Live money should wait for a successful sandbox test, payment
  provider account approval, and a support process for delivery failures/disputes.
- Live keys additionally require `ALLOW_LIVE_PAYMENTS=true` and an HTTPS `PUBLIC_URL`.
  These switches do not certify that the marketplace is approved to process live payments.

## References

- [Stripe-hosted onboarding](https://docs.stripe.com/connect/hosted-onboarding)
- [Separate charges and transfers](https://docs.stripe.com/connect/separate-charges-and-transfers)
- [Webhook handling](https://docs.stripe.com/events/manage-webhook-endpoints)
- [Testing Connect](https://docs.stripe.com/connect/testing)
