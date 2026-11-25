-- Growth: acquisition experiments (posts, directory listings, landing pages...), each with its own ref code.
CREATE TABLE IF NOT EXISTS growth_items (
  id          TEXT PRIMARY KEY,       -- also the ref code in its links (?ref=<id>)
  species     TEXT NOT NULL,
  channel     TEXT NOT NULL,          -- landing | directory | community | social | qa | outreach | launch
  kind        TEXT NOT NULL,          -- owned (the engine ships it) | external (a person posts it)
  target      TEXT,                   -- where: a directory, a subreddit, a search query...
  target_url  TEXT,
  angle       TEXT,                   -- the hypothesis: why this would bring the right people
  title       TEXT,
  body        TEXT,                   -- ready-to-post text (links already carry the ref)
  link        TEXT,                   -- tracked link, or the landing page path for owned items
  rules       TEXT,                   -- the target's self-promotion rules, as checked
  status      TEXT NOT NULL,          -- proposed | live | skipped | retired
  created_at  INTEGER NOT NULL,
  live_at     INTEGER,
  retired_at  INTEGER,
  issue       INTEGER,
  humans      INTEGER DEFAULT 0,      -- distinct real visitors it brought (after a real interaction)
  successes   INTEGER DEFAULT 0,      -- of those, how many reached the species' fitness event
  measured_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_growth_species ON growth_items (species, status);
