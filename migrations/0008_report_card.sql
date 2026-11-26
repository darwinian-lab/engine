-- Report card per simulated session: experience score 0-100 and router-measured effort.
ALTER TABLE sim_runs ADD COLUMN score REAL;
ALTER TABLE sim_runs ADD COLUMN measured TEXT;
-- Blinded side-by-side comparisons: one simulated person does the same task on two arms and says which was better.
CREATE TABLE IF NOT EXISTS sim_pairs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  species TEXT NOT NULL,
  arm_a TEXT NOT NULL,       -- the challenger
  arm_b TEXT NOT NULL,       -- the reference (champion or guard)
  persona TEXT NOT NULL,
  winner TEXT,               -- arm_a, arm_b, or NULL for no preference
  strength INTEGER,          -- 1 slight, 2 clear, 3 strong
  why TEXT,
  report TEXT,
  agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_sim_pairs ON sim_pairs (species, arm_a, ts);
-- The merge commit that made an arm champion (so a regression can be reverted).
ALTER TABLE arms ADD COLUMN merge_sha TEXT;
ALTER TABLE arms ADD COLUMN merged_at INTEGER;
