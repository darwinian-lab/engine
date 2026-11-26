// Membership sync. Subscription offers (species.json offers with an `interval`) are granted by the router into the
// engine's entitlements table. A species can't read that table, so every engine run copies the live members into the
// species' own database as dw_members(visitor, sku, until). A species treats a member as live while until > now, so a
// cancelled, refunded or failed subscription lapses on its own once runs stop refreshing it.

export const MEMBER_TTL_MS = 3 * 24 * 60 * 60 * 1000; // matches the grace the species uses; runs happen at least hourly
const PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const ROWS_PER_INSERT = 30; // 3 bound parameters each, well under D1's per-statement limit
const LIVE_STATUSES = ["active", "sim", "test"]; // same as the router's paidSkus

export const MEMBERS_TABLE_SQL =
  "CREATE TABLE IF NOT EXISTS dw_members (visitor TEXT NOT NULL, sku TEXT NOT NULL, until INTEGER NOT NULL, PRIMARY KEY (visitor, sku))";

export const subscriptionSkus = (speciesConfig) => (speciesConfig?.offers ?? []).filter((o) => o.interval).map((o) => o.sku);

/** Upsert statements that keep `members` live until `until` (never shortening a later until). */
export function memberUpserts(members, until) {
  const out = [];
  for (let i = 0; i < members.length; i += ROWS_PER_INSERT) {
    const chunk = members.slice(i, i + ROWS_PER_INSERT);
    out.push({
      sql: `INSERT INTO dw_members (visitor, sku, until) VALUES ${chunk.map(() => "(?,?,?)").join(",")} ON CONFLICT (visitor, sku) DO UPDATE SET until = MAX(until, excluded.until)`,
      params: chunk.flatMap((m) => [m.visitor, m.sku, until]),
    });
  }
  return out;
}

/** Copy live members of `speciesId` from the engine db into the species db. Returns how many were refreshed. */
export async function syncMembers({ engineDb, speciesDb, speciesId, speciesConfig, now = Date.now() }) {
  const skus = subscriptionSkus(speciesConfig);
  if (!skus.length || !speciesDb) return 0;
  const members = await engineDb.all(
    `SELECT DISTINCT visitor, sku FROM entitlements WHERE species = ? AND status IN (${LIVE_STATUSES.map(() => "?").join(",")}) AND sku IN (${skus.map(() => "?").join(",")})`,
    [speciesId, ...LIVE_STATUSES, ...skus],
  );
  await speciesDb.run(MEMBERS_TABLE_SQL);
  for (const st of memberUpserts(members, now + MEMBER_TTL_MS)) await speciesDb.run(st.sql, st.params);
  await speciesDb.run("DELETE FROM dw_members WHERE until < ?", [now - PRUNE_AFTER_MS]);
  return members.length;
}
