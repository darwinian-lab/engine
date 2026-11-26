import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
// @ts-expect-error plain ESM module without types
import { syncMembers, memberUpserts, MEMBER_TTL_MS } from "../../evolve/lib/members.mjs";

// The engine's d1() client shape (all/run) over node:sqlite.
function sqlite(withEngineMigrations: boolean) {
  const db = new DatabaseSync(":memory:");
  if (withEngineMigrations) {
    const dir = path.join(__dirname, "../../migrations");
    for (const f of fs.readdirSync(dir).sort()) db.exec(fs.readFileSync(path.join(dir, f), "utf8"));
  }
  return {
    raw: db,
    all: async (sql: string, p: unknown[] = []) => db.prepare(sql).all(...(p as never[])),
    run: async (sql: string, p: unknown[] = []) => void db.prepare(sql).run(...(p as never[])),
  };
}

const grant = (db: ReturnType<typeof sqlite>, visitor: string, sku: string, status: string, txn: string) =>
  db.raw.prepare("INSERT INTO entitlements (species, visitor, sku, status, provider, txn_id, code, ts) VALUES ('wall',?,?,?,'paddle',?,?,1)").run(visitor, sku, status, txn, 'code-' + txn);

const config = { offers: [{ sku: "pro_monthly", interval: "month" }, { sku: "pro_yearly", interval: "year" }, { sku: "pro_lifetime" }] };

describe("membership sync", () => {
  it("copies live subscription members into the species db and leaves the rest to lapse", async () => {
    const engineDb = sqlite(true);
    const speciesDb = sqlite(false);
    grant(engineDb, "v-live", "pro_monthly", "active", "t1");
    grant(engineDb, "v-cancelled", "pro_yearly", "canceled", "t2");
    grant(engineDb, "v-refunded", "pro_monthly", "refunded", "t3");
    grant(engineDb, "v-once", "pro_lifetime", "active", "t4");
    const now = 1_000_000;
    expect(await syncMembers({ engineDb, speciesDb, speciesId: "wall", speciesConfig: config, now })).toBe(1);
    expect(await speciesDb.all("SELECT visitor, sku, until FROM dw_members")).toEqual([{ visitor: "v-live", sku: "pro_monthly", until: now + MEMBER_TTL_MS }]);
    // A later run extends; it never shortens a later until written by the species itself.
    await speciesDb.run("UPDATE dw_members SET until = ?", [now + 10 * MEMBER_TTL_MS]);
    await syncMembers({ engineDb, speciesDb, speciesId: "wall", speciesConfig: config, now: now + 1 });
    expect((await speciesDb.all("SELECT until FROM dw_members"))[0]).toEqual({ until: now + 10 * MEMBER_TTL_MS });
  });

  it("does nothing for species without subscription offers", async () => {
    const speciesDb = sqlite(false);
    expect(await syncMembers({ engineDb: sqlite(true), speciesDb, speciesId: "resume", speciesConfig: { offers: [{ sku: "pro_pass" }] } })).toBe(0);
    expect(speciesDb.raw.prepare("SELECT name FROM sqlite_master WHERE name = 'dw_members'").get()).toBeUndefined();
  });

  it("chunks large member lists into bounded statements", () => {
    const members = Array.from({ length: 65 }, (_, i) => ({ visitor: `v${i}`, sku: "pro_monthly" }));
    const st = memberUpserts(members, 5);
    expect(st).toHaveLength(3);
    expect(st.every((s: { params: unknown[] }) => s.params.length <= 90)).toBe(true);
  });
});
