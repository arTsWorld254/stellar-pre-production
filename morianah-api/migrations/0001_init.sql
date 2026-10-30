-- Morianah off-chain schema (D1 / SQLite). Everything here is mutable workflow state.
-- Ownership, provenance and sales live on Stellar; this DB mirrors them, never owns them.

CREATE TABLE profiles (
  address        TEXT PRIMARY KEY,                 -- Stellar G... address
  persona        TEXT NOT NULL CHECK (persona IN ('artist','verifier','curator','collector')),
  display_name   TEXT NOT NULL,
  bio            TEXT,
  country        TEXT,                             -- ISO 3166-1 alpha-2
  avatar_key     TEXT,                             -- R2 object key
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

-- An artist must be vetted before they may upload. Approval here is step one;
-- the on-chain ARTIST_ROLE grant (a verifier-signed transaction) is step two.
CREATE TABLE artist_applications (
  address        TEXT PRIMARY KEY REFERENCES profiles(address),
  statement      TEXT NOT NULL,
  portfolio_url  TEXT,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reviewer       TEXT,
  review_note    TEXT,
  reviewed_at    INTEGER,
  onchain_granted INTEGER NOT NULL DEFAULT 0,      -- 1 once the role grant tx is confirmed
  created_at     INTEGER NOT NULL
);

CREATE TABLE collections (
  id             INTEGER PRIMARY KEY,              -- matches `collection` u32 on chain
  slug           TEXT NOT NULL UNIQUE,
  title          TEXT NOT NULL,
  description    TEXT,
  cover_key      TEXT,
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','live','archived')),
  created_at     INTEGER NOT NULL
);

-- One row per uploaded artwork. The vetting queue is `status = 'pending'`.
CREATE TABLE submissions (
  id             TEXT PRIMARY KEY,                 -- uuid
  artist         TEXT NOT NULL REFERENCES profiles(address),
  collection_id  INTEGER REFERENCES collections(id),
  title          TEXT NOT NULL,
  description    TEXT,
  image_key      TEXT NOT NULL,                    -- R2 key of the canonical file
  sha256         TEXT NOT NULL UNIQUE,             -- hex; same value goes on chain at mint
  mime           TEXT NOT NULL,
  bytes          INTEGER NOT NULL,
  width          INTEGER,
  height         INTEGER,
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','approved','rejected','minted')),
  reviewer       TEXT,
  review_note    TEXT,
  reviewed_at    INTEGER,
  cid            TEXT,                             -- IPFS CID of metadata, set at mint (step 4)
  token_id       INTEGER,                          -- on-chain token id, set at mint (step 4)
  created_at     INTEGER NOT NULL
);
CREATE INDEX idx_submissions_status ON submissions(status, created_at);
CREATE INDEX idx_submissions_artist ON submissions(artist, created_at);

-- Issued by SEP-10 login (step 3). Seeded by hand in dev.
CREATE TABLE sessions (
  token          TEXT PRIMARY KEY,
  address        TEXT NOT NULL,
  expires_at     INTEGER NOT NULL
);

CREATE TABLE audit_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  at             INTEGER NOT NULL,
  actor          TEXT NOT NULL,
  action         TEXT NOT NULL,
  subject        TEXT,
  detail         TEXT
);
