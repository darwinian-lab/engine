-- Simulated users, the nursery, the seed bank and the issue backlog.
-- Applied idempotently by evolve/run.mjs (ensureSchema) on every run.

-- Arm statuses now also include 'nursery' (deployed, judged by simulated users only).
ALTER TABLE arms ADD COLUMN revived_from TEXT;    -- root arm id this arm re-introduces (seed bank)
ALTER TABLE arms ADD COLUMN revivable INTEGER;    -- 1 if it may be revived after death (never for charter violations)
ALTER TABLE arms ADD COLUMN died_gen INTEGER;     -- species generation when it died
ALTER TABLE arms ADD COLUMN final_score REAL;     -- how close it came (0..1) when it died
ALTER TABLE arms ADD COLUMN issue INTEGER;        -- backlog issue number it implements
ALTER TABLE arms ADD COLUMN graduated_at INTEGER; -- when it left the nursery for real traffic

-- One simulated person using one arm, possibly across several sessions ("comes back two days later").
CREATE TABLE IF NOT EXISTS sim_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  species     TEXT NOT NULL,
  arm_id      TEXT NOT NULL,
  persona     TEXT NOT NULL,
  device      TEXT NOT NULL,
  outcome     TEXT NOT NULL,        -- success | fail | error
  stage_hit   INTEGER NOT NULL,     -- the router saw the current stage's fitness event
  done        INTEGER NOT NULL,     -- the person says they achieved every goal
  rating      INTEGER,              -- 1..5, how they felt about it
  minutes     REAL,
  report      TEXT                  -- JSON {summary, phases:[...], stuck, wishes, liked, quote}
);
CREATE INDEX IF NOT EXISTS idx_sim_arm ON sim_runs (species, arm_id, ts);
