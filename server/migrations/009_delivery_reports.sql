-- A buyer's delivery problem stops auto-confirmation until someone reviews it.
ALTER TABLE order_fills
  ADD COLUMN problem_reported_at timestamptz,
  ADD COLUMN problem_reason text,
  ADD COLUMN auto_confirmed boolean NOT NULL DEFAULT false;
