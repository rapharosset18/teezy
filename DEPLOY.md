# Put Teezy online for testers (Railway)

This runs the real Teezy app (accounts, listings, Stripe test payments) at a public
address you can send to people. Each person signs in with their own email.

Everything here is **test mode**: payments use Stripe test cards and no real money moves.

## What you need

| Account | Cost | What for |
|---|---|---|
| [Railway](https://railway.com) (Hobby plan) | $5/month, includes $5 of usage | Runs the server and the database |
| [Resend](https://resend.com) | Free up to 3,000 emails/month | Sends the 6-digit sign-in codes |
| A domain (any registrar) | ~$10/year | Resend only sends to other people from a domain you own |
| [Stripe](https://dashboard.stripe.com) sandbox with Connect | Free | Test checkout and seller payouts (see PAYMENTS.md) |

Never paste keys into chat or commit them. They go only into Railway's Variables tab.

## 1. Create the Railway project

1. Sign in to Railway with GitHub.
2. **New Project → Deploy from GitHub repo →** pick `teezy`.
3. Open the new service → **Settings → Source → Branch**: choose
   `stripe-marketplace-payments` (that branch has the server-connected app).
4. In the project, **+ Create → Database → PostgreSQL**.
5. **Settings → Networking → Generate Domain** on the Teezy service. Copy the address,
   e.g. `https://teezy-production.up.railway.app`. This is the link you send testers.

Railway reads `railway.json`: it runs `npm start` and checks `/api/runtime` before
switching traffic to a new deploy. The first start creates the tables and adds the games.

## 2. Set the variables

Teezy service → **Variables** → add:

| Variable | Value |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (Railway fills it in) |
| `NODE_ENV` | `production` |
| `PUBLIC_URL` | your Railway address from step 1.5, no trailing slash |
| `EMAIL_PROVIDER` | `resend` |
| `RESEND_API_KEY` | from Resend → API Keys |
| `EMAIL_FROM` | e.g. `Teezy <login@yourdomain.com>` (the domain verified in Resend) |
| `PAYMENT_PROVIDER` | `stripe` |
| `STRIPE_SECRET_KEY` | your Stripe **test** secret key (`sk_test_…`) |
| `STRIPE_WEBHOOK_SECRET` | from step 4 (platform endpoint) |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | from step 4 (connected accounts endpoint) |
| `ALLOW_LIVE_PAYMENTS` | `false` |

Optional: `SEED_SAMPLE_LISTINGS=true` adds the sample sellers' listings on the first start,
so the app doesn't look empty. Those sellers have no Stripe accounts, so buying them won't
complete; leave it off once real testers are listing.

Railway redeploys after you save variables.

## 3. Resend (sign-in emails)

1. **Domains → Add domain**, and add the DNS records it shows at your domain registrar.
2. Wait until the domain shows **Verified**.
3. **API Keys → Create** (sending access) and put it in `RESEND_API_KEY`.

Without a verified domain, Resend only delivers to your own email address.

## 4. Stripe webhooks

In the Stripe dashboard (sandbox), **Developers → Webhooks → Add endpoint**, twice,
both pointing at `https://<your Railway address>/api/webhooks/stripe`:

1. **Your account** events: `checkout.session.completed`,
   `checkout.session.async_payment_succeeded`, `charge.refunded`, `refund.updated`,
   `charge.dispute.created`, `charge.dispute.closed`, `transfer.created`.
   Its signing secret → `STRIPE_WEBHOOK_SECRET`.
2. **Connected accounts** events: `account.updated`.
   Its signing secret → `STRIPE_CONNECT_WEBHOOK_SECRET`.

Set the endpoint API version as described in PAYMENTS.md. Stripe Connect must be set up
for your platform first (PAYMENTS.md, "Connect your Stripe sandbox", step 1).

## 5. Check it works

1. Open your Railway address. You should see the Teezy home with the games.
2. Sign in with your email; the code arrives from Resend.
3. Sell: **Account → Payments and payouts → Connect seller payouts**, finish Stripe's test
   onboarding, then list a ticket.
4. In a private window, sign in with a second email and buy it with card
   `4242 4242 4242 4242`, any future expiry, any CVC.
5. Railway → service → **Deployments → View logs** shows errors. Lines starting with
   `[setup]` mean a variable is missing.

## What testers can and can't do

Works: sign in, browse games, the designed event page and seat sheet, buy with test cards,
sell after connecting payouts, price alerts, My Tickets / Dashboard / Inbox (plain versions),
confirming delivery and reporting problems.

Not on the server yet (shows "not connected yet"): offers and counters, chat, friends,
album, organization sign-up, sending a ticket to a friend, QR ticket wallet, cash out.

## Updating

Every push to `stripe-marketplace-payments` redeploys. The database keeps its data
between deploys. New games are added in `server/seed.js` only on a fresh database, so add
them with SQL (Railway → Postgres → Data) or ask for a small admin script.
