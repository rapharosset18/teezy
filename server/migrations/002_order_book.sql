-- Price-time priority. A listing's place in line is priority_timestamp; the trigger
-- below owns it, so no code path can forget to reset it or set it by hand.

ALTER TABLE listings
  ADD COLUMN priority_timestamp timestamptz NOT NULL DEFAULT clock_timestamp();

CREATE FUNCTION listings_before_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.price_cents IS DISTINCT FROM OLD.price_cents THEN
    -- A new price re-queues the listing, like a new order on an exchange.
    NEW.priority_timestamp := clock_timestamp();
  ELSE
    -- Description, seat details, quantity changes keep their place in line.
    NEW.priority_timestamp := OLD.priority_timestamp;
  END IF;

  IF NEW.status <> 'withdrawn' THEN
    NEW.status := CASE WHEN NEW.qty_available = 0 THEN 'sold' ELSE 'active' END;
  END IF;

  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER listings_before_update
  BEFORE UPDATE ON listings
  FOR EACH ROW EXECUTE FUNCTION listings_before_update();

-- The order book: active listings per event and tier in match order.
CREATE INDEX listings_book_idx
  ON listings (event_id, tier, price_cents, priority_timestamp, id)
  WHERE status = 'active';
