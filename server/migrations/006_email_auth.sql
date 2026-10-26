-- Sign-in by email code. Any email address works: verifying it proves the person
-- controls the inbox, nothing more (no school or domain check).

ALTER TABLE users
  ADD COLUMN email             text UNIQUE,   -- lowercased; NULL for demo/seed users
  ADD COLUMN email_verified_at timestamptz;

CREATE TABLE email_login_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL,
  code_hash   text NOT NULL,                  -- sha256 of the 6-digit code, never the code itself
  attempts    integer NOT NULL DEFAULT 0,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX email_login_codes_email_idx ON email_login_codes (email, created_at DESC);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,                -- sha256 of the cookie token
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX sessions_user_idx ON sessions (user_id);
