-- D1 free tier is 5M rows read per day. These let per-visitor and time-window queries read only what they need.
CREATE INDEX IF NOT EXISTS idx_events_visitor ON events (species, visitor, ts);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events (species, ts);
