# Teezy MVP implementation

Launch scope: curated events near USC, verified-email accounts, ticket listings,
price matching, checkout, official ticket transfer, and buyer/seller history.

## Step 1 — Marketplace data

Implemented read endpoints (all collection responses contain `items`, `limit`,
`offset`, and `hasMore`; default page size 20, maximum 100):

- `GET /api/events/:eventId`: event details and available tiers.
- `GET /api/listings`: available listings for future events. Filters: `eventId`,
  `tier`, `qty`, `maxPriceCents`, `q` (event name), `sort=price|newest`, `limit`, `offset`.
- `GET /api/listings/:id`: listing details; withdrawn/unavailable listings are visible
  only to their seller.
- `GET /api/me/listings`: the signed-in seller's listings, including withdrawn and
  unavailable inventory. Optional `status=active|sold|withdrawn` and browsing filters.
- `GET /api/me/orders`: the signed-in buyer's orders, including payment expiry state.
- `GET /api/me/sales`: orders involving the signed-in seller, with only that seller's fills.

Public browsing works without sign-in. Account endpoints require sessions in
production; local development retains the existing demo identity behavior.
The connected app uses these endpoints for browsing and account history.

## Step 2 — Connect the app

Implemented email sign-in, database-backed event/listing browsing, listing creation
and editing, checkout, purchase/sales history, seller transfer recording, and buyer
receipt confirmation. A development-only `/transfer-test.html` page switches between
two local practice accounts and verifies saved transfer progress.

The active `web/index.html` is generated from `prototype/index.html`; edit the
prototype and use its sync script. `prototype/backend.js` contains the API connection
and connected screens. Unsupported features no longer simulate transactions in the
connected marketplace.

## Step 3 — Real payments

Stripe checkout, seller onboarding, signed/deduplicated webhooks, transaction
records, refund handling, and delayed seller transfers are implemented. The app
uses provider Checkout for Stripe orders; the old `/pay` simulation is blocked for
those orders. Seller transfers require buyer confirmation and a configurable
delay after the event starts (default 24 hours). See [PAYMENTS.md](PAYMENTS.md)
for account setup and testing. Actual Stripe sandbox/live verification is pending
the owner's credentials and account setup. No live payments have been enabled.

## Step 4 — Delivery and support

Add seller-authorized transfer recording per fill, buyer confirmation, delivery
deadlines, disputes, cancellation/refund handling, and controlled payout jobs.
Start with official ticket transfer and manual review; automatic gate-scan
verification requires a ticketing/venue integration. Add admin-only event,
listing, user, and dispute tools with an audit trail.

## Step 5 — Launch checks

Configure real email delivery, transaction notifications, managed Postgres,
separate API/worker processes, HTTPS, secrets, backups, health checks, monitoring,
and abuse limits. Verify one complete transaction with two accounts, including
refund and failed-delivery cases, before accepting live payments.

Defer friends, albums, dues, installments, parking, and ticket trades. Offers and
chat can follow the fixed-price flow, or be included before launch if negotiation
is required for the initial pilot.
