-- Engine capability: payments (router/src/pay.ts). The router records what each visitor owns; arms only read it.
CREATE TABLE IF NOT EXISTS entitlements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  species TEXT NOT NULL,
  visitor TEXT NOT NULL,          -- router visitor id that owns it (a restore adds another row for the new browser)
  sku TEXT NOT NULL,              -- offer id from species.json
  status TEXT NOT NULL,           -- active | canceled | refunded | sim (simulated person) | test (Paddle sandbox)
  provider TEXT NOT NULL,         -- paddle | paddle-sandbox | sim
  txn_id TEXT NOT NULL,
  subscription_id TEXT,
  customer_id TEXT,
  code TEXT NOT NULL,             -- purchase code shown to the buyer, unlocks other browsers
  amount REAL,
  currency TEXT,
  arm_id TEXT,                    -- arm that made the sale
  ts INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ent_txn ON entitlements (species, provider, txn_id, visitor);
CREATE INDEX IF NOT EXISTS idx_ent_visitor ON entitlements (species, visitor);
CREATE INDEX IF NOT EXISTS idx_ent_code ON entitlements (species, code);
CREATE INDEX IF NOT EXISTS idx_ent_sub ON entitlements (species, subscription_id);
-- Each provider notification is processed once.
CREATE TABLE IF NOT EXISTS pay_events (
  species TEXT NOT NULL, event_id TEXT NOT NULL, ts INTEGER NOT NULL, type TEXT, json TEXT,
  PRIMARY KEY (species, event_id)
);
