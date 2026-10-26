# Teezy order book: how it works and what production needs

## Matching ("Buy at $X")

`server/services/orders.js` → `buyAtPrice()`, in one Postgres transaction:

1. Lock candidate listings in rank order with
   `SELECT … FOR UPDATE OF l SKIP LOCKED`. Candidates: same event, same tier (or any),
   active, not the buyer's own, `price_cents <= max`, enough tickets.
2. Rank them with `rankListings()` and plan the fills (`planFills()`).
3. Decrement `qty_available`, insert the `orders` row (`pending_payment`) and one
   `order_fills` row per seller, and enqueue the payment-expiry job. All of this happens in the
   same transaction.

If the only seats left are locked by buyers who are mid-match, the transaction releases
its own locks (rollback to savepoint), waits on theirs, and looks again, until
`MATCH_DEADLINE_MS` (5 s). Then it returns `busy`. Locks are always released before
waiting, so waits can't deadlock.

Rules:

- **Price, then time.** The lowest price wins. At the same price, the earliest
  `priority_timestamp` wins, then the listing id breaks any remaining tie.
- **Buyer pays the listing price**, never their max, plus the 5% buyer fee.
- **One seller per order by default**, so seats stay together. With `allowSplit`, an order
  fills across sellers in priority order and opens one escrow per seller.
- **All-or-nothing.** A buyer who wants 2 tickets never gets 1.
- **No self-matching.** A buyer is never matched against their own listing.
- **Unpaid orders expire** after `PAYMENT_WINDOW_MS` (5 min). The job restores the seats,
  and each listing keeps its place in line.

### Ranking lives in one place

`server/engine/ranking.js` holds `RANK_RULES`. Each rule carries both a JS comparator and the
SQL `ORDER BY` term, so lock order and `rankListings()` can't drift apart.
`test/ranking.test.js` checks that they agree on real rows. To add seller rating, add a rule
(the comment in the file shows where and how). The candidate query already joins the
seller's `users` row as `u`.

### Priority timestamp

The `listings_before_update` trigger (`002_order_book.sql`) owns `priority_timestamp`. A price
change resets it to `clock_timestamp()`; every other update keeps the old value, even an
explicit `SET priority_timestamp = …`. Quantity changes from sales and expiries also keep it.

## Market average (slider "good deal")

The median price per ticket of paid sales (`completed_sales` view) for the event and tier over
the last 30 days, when there are at least 5 sales. Otherwise it's the median of active asking
prices. The median is used, not the mean, so one $0 or $400 outlier in a thin student market
doesn't skew it. A price point is a good deal at `GOOD_DEAL_THRESHOLD` (15%) or more below the
average, and only when a listing exists at that price.

The slider fetches `GET /api/events/:id/price-data` once per view, and again on focus or a
live `book` event. It counts "N available" on the client as the slider moves.

## Desired ticket alerts

- A listing create or price drop enqueues a `listing-changed` job inside the same
  transaction (pg-boss with the request's client). A rolled-back write never alerts.
- `checkDesiredForListing()` finds matching entries: same event, same tier or any, price ≤ max,
  enough tickets, not paused, and not the seller's own entry. For each entry it locks the row,
  checks the cooldown (`ALERT_COOLDOWN_MS`, 30 min), and inserts into
  `desired_ticket_notifications`. That table's primary key `(entry, listing)` guarantees at
  most one alert per listing.
- The notification is stored (the inbox record), then sent with `sendPush()`. A failed send
  leaves the inbox record in place.
- The deep link `/?event=…&tier=…&qty=…&price=<entry max>` opens the slider pre-set to the
  entry's price.

## Before going live

| Area | Today (demo) | Production |
|---|---|---|
| Sign-in | Email + 6-digit code, any address, session cookie. Dev: the code is printed to the server log and filled in for you; signed-out calls act as `mia` | `NODE_ENV=production` refuses signed-out calls and never returns the code; set `EMAIL_PROVIDER=resend`, `RESEND_API_KEY` and `EMAIL_FROM` on a domain you verify with Resend |
| Payment | `POST /orders/:id/pay` marks the money held | A payment provider authorization (e.g. Stripe manual capture) in `advanceEscrow('pay')`; capture or refund on release |
| Transfer / release | Buttons in the demo call `/transfer` and `/release` (disabled in production) | Seller action plus a job scheduled after the event |
| Push | `PUSH_PROVIDER=dev`: banner over SSE | `PUSH_PROVIDER=expo`, with the app registering tokens at `POST /api/push-tokens`. Expo delivers to APNs and FCM. Untested against Expo's live API. |
| Worker | Runs inside the API process (`npm run dev`) | Separate process calling `startWorker()` from `server/worker.js` |
| Database | `embedded-postgres` in `.pgdata` | Managed Postgres; `DATABASE_URL=… npm run migrate` |
| Realtime | `LISTEN teezy` → SSE | Same; works across API instances because NOTIFY goes through Postgres |

## Not covered by the order book

- Negotiation (offers, counters, trades) is still the demo's client-side chat. When it moves
  to the server, an accepted offer should open escrow through the same `openOrder()` path, so
  there's still one payment flow.
- Free basketball tickets, organizer "buy now" items and club dues are not in the order book.
- Matching keys on tier (`ga`, `student`, `reserved`, `entry`). Section and row are stored for
  display only.
