-- "Desired Ticket" alerts from the profile.

CREATE TABLE desired_tickets (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id         text NOT NULL REFERENCES events(id),
  tier             text,                    -- NULL = any section
  qty              integer NOT NULL CHECK (qty BETWEEN 1 AND 10),
  max_price_cents  integer NOT NULL CHECK (max_price_cents > 0),
  paused           boolean NOT NULL DEFAULT false,
  last_notified_at timestamptz,             -- for the per-entry cooldown
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at       timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX desired_tickets_user_idx ON desired_tickets (user_id, created_at);
CREATE INDEX desired_tickets_match_idx ON desired_tickets (event_id, max_price_cents) WHERE NOT paused;

-- One row per entry and listing: the primary key is what guarantees at most one alert each.
CREATE TABLE desired_ticket_notifications (
  desired_ticket_id uuid NOT NULL REFERENCES desired_tickets(id) ON DELETE CASCADE,
  listing_id        uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  trigger           text NOT NULL CHECK (trigger IN ('created', 'price_drop')),
  notified_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (desired_ticket_id, listing_id)
);
