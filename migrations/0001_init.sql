-- Darwinian engine database (shared by all species).
-- The engine owns this schema. Species code never writes here directly;
-- everything arrives through the router.

-- Every organism that ever lived. Rows are never deleted (fossil record).
CREATE TABLE IF NOT EXISTS arms (
  species     TEXT NOT NULL,
  arm_id      TEXT NOT NULL,
  origin      TEXT NOT NULL,             -- e.g. https://sp-qr-g3-k2f9.example.workers.dev
  status      TEXT NOT NULL,             -- candidate | live | control | champion | retired | dead
  generation  INTEGER NOT NULL DEFAULT 0,
  parent      TEXT,                      -- arm_id of parent (NULL for gen 0)
  git_ref     TEXT,                      -- tag / commit in the species repo
  hypothesis  TEXT,                      -- what the mutation tried, in one paragraph
  created_at  INTEGER NOT NULL,          -- unix ms
  retired_at  INTEGER,
  cause       TEXT,                      -- why it was retired / died
  PRIMARY KEY (species, arm_id)
);

-- Raw events observed by the router (server-side) or sent by the injected beacon.
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  species     TEXT NOT NULL,
  arm_id      TEXT NOT NULL,
  visitor     TEXT NOT NULL,
  segment     TEXT NOT NULL,             -- mobile | desktop
  name        TEXT NOT NULL,             -- pageview | js_seen | <fitness event> | http_5xx
  path        TEXT,
  value       REAL,                      -- revenue in USD for purchase events
  props       TEXT                       -- small JSON blob
);
CREATE INDEX IF NOT EXISTS idx_events_lookup ON events (species, arm_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_name ON events (species, name, ts);

-- Aggregated by the router cron; read by the router for Thompson sampling.
CREATE TABLE IF NOT EXISTS arm_stats (
  species     TEXT NOT NULL,
  arm_id      TEXT NOT NULL,
  segment     TEXT NOT NULL,             -- mobile | desktop | all
  trials      INTEGER NOT NULL,          -- unique human visitors (sent js_seen) in the window
  successes   INTEGER NOT NULL,          -- of those, visitors who did the current stage event
  revenue     REAL NOT NULL DEFAULT 0,
  requests    INTEGER NOT NULL DEFAULT 0,
  errors      INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (species, arm_id, segment)
);

-- Per-species state: which fitness stage is active, generation counter.
CREATE TABLE IF NOT EXISTS species_state (
  species     TEXT PRIMARY KEY,
  stage       INTEGER NOT NULL DEFAULT 0,
  generation  INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL
);

-- Copy of each species' protected species.json (published by the species repo's CI).
CREATE TABLE IF NOT EXISTS species_config (
  species     TEXT PRIMARY KEY,
  json        TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Append-only journal of everything the evolution loop decided (for the digest + science).
CREATE TABLE IF NOT EXISTS journal (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  species     TEXT,
  kind        TEXT NOT NULL,             -- spawn | reject | deploy | promote | retire | death | stage | note
  arm_id      TEXT,
  detail      TEXT
);
