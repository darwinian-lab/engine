-- Incremental stats: the router updates these small tables as events arrive, so recounting arm stats reads a few
-- thousand rows instead of scanning every raw event.
-- Last time each visitor did each meaningful thing on each arm (js_seen, fitness events...), so a 14-day window
-- counts anyone active in it, as the raw-event query did.
CREATE TABLE IF NOT EXISTS visitor_firsts (
  species TEXT NOT NULL, arm_id TEXT NOT NULL, visitor TEXT NOT NULL, name TEXT NOT NULL, segment TEXT, ts INTEGER NOT NULL,
  PRIMARY KEY (species, arm_id, visitor, name)
);
CREATE INDEX IF NOT EXISTS idx_vf_name ON visitor_firsts (species, name, ts);
-- Requests, errors and revenue per arm per hour.
CREATE TABLE IF NOT EXISTS arm_hourly (
  species TEXT NOT NULL, arm_id TEXT NOT NULL, hour INTEGER NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0, revenue REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (species, arm_id, hour)
);
-- Backfill from existing events (runs once: migrations are recorded in _migrations).
INSERT OR IGNORE INTO visitor_firsts (species, arm_id, visitor, name, segment, ts)
  SELECT species, arm_id, visitor, name, segment, MAX(ts) FROM events
  WHERE name NOT IN ('pageview','http_5xx') AND name NOT LIKE 'c:%' GROUP BY species, arm_id, visitor, name;
INSERT OR IGNORE INTO arm_hourly (species, arm_id, hour, requests, errors, revenue)
  SELECT species, arm_id, ts / 3600000, SUM(name IN ('pageview','http_5xx')), SUM(name = 'http_5xx'), SUM(CASE WHEN name = 'purchase' THEN COALESCE(value, 0) ELSE 0 END)
  FROM events GROUP BY species, arm_id, ts / 3600000;
