ALTER TABLE order_fills
  ADD COLUMN transfer_reference text,
  ADD COLUMN transferred_at timestamptz,
  ADD COLUMN confirmed_at timestamptz;
