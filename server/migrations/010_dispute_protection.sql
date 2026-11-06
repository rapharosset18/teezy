-- Proof of delivery is what qualifies a seller for chargeback protection.
CREATE TABLE delivery_proofs (
  fill_id uuid PRIMARY KEY REFERENCES order_fills(id) ON DELETE CASCADE,
  filename text NOT NULL,
  content_type text NOT NULL CHECK (content_type IN ('image/png','image/jpeg','application/pdf')),
  data bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE payments
  ADD COLUMN stripe_dispute_id text,
  ADD COLUMN dispute_outcome text CHECK (dispute_outcome IN ('won','lost')),
  ADD COLUMN evidence_submitted_at timestamptz;

-- True when Teezy funded this payout itself, after a lost chargeback or a repayment.
ALTER TABLE seller_transfers ADD COLUMN covered boolean NOT NULL DEFAULT false;

ALTER TABLE users
  ADD COLUMN payment_blocked_at timestamptz,
  ADD COLUMN payment_blocked_reason text;
