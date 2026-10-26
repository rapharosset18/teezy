-- A "Buy at $X" order and the listings it filled. Each fill is paid to one seller,
-- so escrow state lives on the fill: a two-seller order is two escrows.

CREATE TABLE orders (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id           text NOT NULL REFERENCES users(id),
  event_id           text NOT NULL REFERENCES events(id),
  tier               text,                    -- NULL = any section
  qty                integer NOT NULL CHECK (qty > 0),
  max_price_cents    integer NOT NULL CHECK (max_price_cents > 0),
  allow_split        boolean NOT NULL DEFAULT false,
  subtotal_cents     integer NOT NULL CHECK (subtotal_cents >= 0),
  buyer_fee_cents    integer NOT NULL CHECK (buyer_fee_cents >= 0),
  total_cents        integer NOT NULL CHECK (total_cents >= 0),
  status             text NOT NULL DEFAULT 'pending_payment'
                     CHECK (status IN ('pending_payment', 'paid', 'expired', 'cancelled')),
  payment_expires_at timestamptz NOT NULL,
  paid_at            timestamptz,
  created_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at         timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX orders_buyer_idx ON orders (buyer_id, created_at DESC);

CREATE TABLE order_fills (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  listing_id    uuid NOT NULL REFERENCES listings(id),
  seller_id     text NOT NULL REFERENCES users(id),
  qty           integer NOT NULL CHECK (qty > 0),
  price_cents   integer NOT NULL CHECK (price_cents > 0),   -- per ticket, the listing's price
  escrow_status text NOT NULL DEFAULT 'awaiting_payment'
                CHECK (escrow_status IN ('awaiting_payment', 'held', 'transferred', 'confirmed',
                                         'released', 'refunded', 'void')),
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at    timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX order_fills_order_idx ON order_fills (order_id);
CREATE INDEX order_fills_listing_idx ON order_fills (listing_id);

-- Paid sales, per ticket. Feeds the market average on the price slider.
CREATE VIEW completed_sales AS
SELECT f.id, l.event_id, l.tier, f.price_cents, o.paid_at AS sold_at
FROM order_fills f
JOIN orders o ON o.id = f.order_id
JOIN listings l ON l.id = f.listing_id
WHERE f.escrow_status IN ('held', 'transferred', 'confirmed', 'released');
