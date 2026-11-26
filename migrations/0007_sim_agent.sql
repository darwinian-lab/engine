-- Which model ran each simulated session. Selection compares arms only on sessions from the current simulator,
-- so a switch (Claude Haiku -> Codex on 2026-11-25 21:05 UTC) doesn't pit old-instrument numbers against new ones.
ALTER TABLE sim_runs ADD COLUMN agent TEXT;
UPDATE sim_runs SET agent='codex' WHERE agent IS NULL AND ts >= 1795640700000;
UPDATE sim_runs SET agent='claude' WHERE agent IS NULL;
