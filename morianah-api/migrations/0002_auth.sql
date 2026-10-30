-- SEP-10 challenges: issued once, redeemed once.
CREATE TABLE auth_challenges (
  hash        TEXT PRIMARY KEY,     -- sha256 of the server-signed challenge XDR
  account     TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER
);
CREATE INDEX idx_auth_challenges_exp ON auth_challenges(expires_at);
CREATE INDEX idx_sessions_exp ON sessions(expires_at);
