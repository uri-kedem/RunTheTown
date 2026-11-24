-- The accounts database (Cloudflare D1, which is SQLite). Every statement can be run again
-- on a database that already has the tables: `npx wrangler d1 execute runthetown --remote --file=schema.sql`.

-- One row per runner with an account. The e-mail address is the one the runner proved
-- (by the code we sent, or by Google or Apple vouching for it), in lower case; google_sub
-- and apple_sub are those services' own ids for the person, so a later change of address
-- there still finds the same account. The profile is the app's own JSON (name, photos).
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  google_sub TEXT UNIQUE,
  apple_sub TEXT UNIQUE,
  created INTEGER NOT NULL,
  profile TEXT,
  profile_updated INTEGER NOT NULL DEFAULT 0
);

-- A phone or a browser that is signed in. Only a hash of its key is kept: whoever reads
-- this table cannot sign in with what is in it.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created INTEGER NOT NULL,
  last_used INTEGER NOT NULL,
  device TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);

-- The code last sent to an address, hashed, with when it stops working and how many wrong
-- guesses it has had. One row per address: a new code replaces the old one.
CREATE TABLE IF NOT EXISTS codes (
  email TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  sent INTEGER NOT NULL
);

-- The run journal: the app's own JSON for a run (without its map picture, which each
-- phone draws for itself). A deleted run stays as a row with `deleted` set and no body, so
-- the runner's other phone learns it was deleted instead of sending it back.
CREATE TABLE IF NOT EXISTS runs (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  time TEXT,
  updated INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  body TEXT,
  PRIMARY KEY (user_id, id)
);

-- Counters behind the limits on how often a code may be asked for or guessed.
CREATE TABLE IF NOT EXISTS limits (
  key TEXT PRIMARY KEY,
  start INTEGER NOT NULL,
  n INTEGER NOT NULL
);
