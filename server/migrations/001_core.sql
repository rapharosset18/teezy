-- Users, events and listings. Money is stored in integer cents everywhere.

CREATE TABLE users (
  id               text PRIMARY KEY,          -- demo uses handles; production keys come from auth
  display_name     text NOT NULL,
  rating           numeric(2,1),
  -- Max price per ticket the buyer is willing to pay. Caps the price slider.
  max_budget_cents integer CHECK (max_budget_cents IS NULL OR max_budget_cents > 0),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE events (
  id         text PRIMARY KEY,
  name       text NOT NULL,
  venue      text,
  starts_at  timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE listings (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id       text NOT NULL REFERENCES events(id),
  seller_id      text NOT NULL REFERENCES users(id),
  -- What matching keys on: ga, student, reserved, entry...
  tier           text NOT NULL,
  -- Shown to buyers but not matched on.
  section        text,
  seat_label     text,
  description    text,
  price_cents    integer NOT NULL CHECK (price_cents > 0),   -- per ticket
  qty_total      integer NOT NULL CHECK (qty_total > 0),
  qty_available  integer NOT NULL CHECK (qty_available >= 0 AND qty_available <= qty_total),
  accepts_offers boolean NOT NULL DEFAULT true,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'sold', 'withdrawn')),
  created_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at     timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX listings_seller_idx ON listings (seller_id);
