-- Lab dashboard data: what each mutation did, how it looked, how its odds moved.
-- Applied idempotently by evolve/run.mjs (ensureSchema) on every run; kept here as the record.

ALTER TABLE arms ADD COLUMN mutation TEXT;   -- full MUTATION.md
ALTER TABLE arms ADD COLUMN size TEXT;       -- small | medium | large
ALTER TABLE arms ADD COLUMN diffstat TEXT;   -- JSON [{path, add, del}]
ALTER TABLE arms ADD COLUMN audit TEXT;      -- JSON {summary, notes, rounds}
ALTER TABLE arms ADD COLUMN personas TEXT;   -- JSON [{persona, prefers, strength, why}]
ALTER TABLE arms ADD COLUMN shot_at INTEGER; -- when screenshots were last taken

-- Screenshots and short videos of each arm. Bytes are base64 in chunks (D1 rows stay small).
CREATE TABLE IF NOT EXISTS media (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  species     TEXT NOT NULL,
  arm_id      TEXT NOT NULL,
  kind        TEXT NOT NULL,             -- shot | video
  page        TEXT,
  viewport    TEXT,                      -- desktop | mobile
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  width       INTEGER,
  height      INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_arm ON media (species, arm_id);
CREATE TABLE IF NOT EXISTS media_chunk (
  media_id    INTEGER NOT NULL,
  seq         INTEGER NOT NULL,
  data        TEXT NOT NULL,
  PRIMARY KEY (media_id, seq)
);

-- P(best) of each competing arm, snapshotted every evolve cycle.
CREATE TABLE IF NOT EXISTS pb_history (
  ts          INTEGER NOT NULL,
  species     TEXT NOT NULL,
  arm_id      TEXT NOT NULL,
  pbest       REAL NOT NULL,
  trials      INTEGER NOT NULL,
  successes   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pb ON pb_history (species, ts);
