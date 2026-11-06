CREATE TABLE seller_accounts (
  user_id text PRIMARY KEY REFERENCES users(id),
  stripe_account_id text UNIQUE NOT NULL,
  livemode boolean NOT NULL,
  transfers_enabled boolean NOT NULL DEFAULT false,
  payouts_enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payments (
  order_id uuid PRIMARY KEY REFERENCES orders(id),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  currency text NOT NULL DEFAULT 'usd',
  description text NOT NULL,
  livemode boolean NOT NULL,
  checkout_expires_at timestamptz NOT NULL,
  stripe_session_id text UNIQUE,
  stripe_payment_intent_id text UNIQUE,
  stripe_charge_id text UNIQUE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','succeeded','expired','refund_pending','refunded','disputed','review')),
  refunded_cents integer NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0),
  dispute_open boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE seller_transfers (
  fill_id uuid PRIMARY KEY REFERENCES order_fills(id),
  seller_id text NOT NULL REFERENCES users(id),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  stripe_transfer_id text UNIQUE,
  stripe_reversal_id text UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','transferred','reversed')),
  transferred_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One immutable entry per provider operation; duplicate delivery cannot add money twice.
CREATE TABLE payment_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  fill_id uuid REFERENCES order_fills(id),
  kind text NOT NULL CHECK (kind IN ('charge','refund','transfer','reversal','dispute')),
  amount_cents integer NOT NULL,
  provider_reference text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payment_webhooks (
  event_id text PRIMARY KEY,
  event_type text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

CREATE INDEX payments_pending_idx ON payments(checkout_expires_at) WHERE status = 'pending';
