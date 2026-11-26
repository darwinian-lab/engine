import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { handlePay, hmacHex, verifyPaddle, payReady, clientConfig, priceLabel } from "../src/pay";
import { logEvent, type Env } from "../src/index";
import type { SpeciesConfig } from "../src/config";

// A tiny D1 stand-in over node:sqlite with the engine's real migrations.
function fakeD1() {
  const db = new DatabaseSync(":memory:");
  const dir = path.join(__dirname, "../../migrations");
  for (const f of fs.readdirSync(dir).sort()) db.exec(fs.readFileSync(path.join(dir, f), "utf8"));
  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...(args as never[])).changes) } }),
    first: async () => (db.prepare(sql).get(...(args as never[])) as never) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...(args as never[])) as never[] }),
  });
  return {
    raw: db,
    prepare: (sql: string) => stmt(sql),
    batch: async (list: { run: () => Promise<unknown> }[]) => Promise.all(list.map((s) => s.run())),
  } as unknown as D1Database & { raw: DatabaseSync };
}

const cfg: SpeciesConfig = {
  species: "wall",
  brand: { name: "Kudospage", domain: "kudospage.com" },
  stages: [{ name: "activation", event: "wall_created" }],
  events: [],
  offers: [
    { sku: "pro_monthly", name: "Kudospage Pro", price: 9, currency: "USD", interval: "month" },
    { sku: "pro_lifetime", name: "Kudospage Pro (lifetime)", price: 49, currency: "USD" },
  ],
};
const SECRET = "pdl_ntfset_test_secret";
let env: Env;
const visitor = { visitor: "v1", arm: "g3-abc", segment: "desktop", sim: false, owner: false };
const call = (url: string, init: RequestInit = {}, v = visitor) =>
  handlePay(new Request(`https://kudospage.com${url}`, init), env, cfg, v, logEvent, (p) => void p);

async function signed(body: unknown, ts = Math.floor(Date.now() / 1000)) {
  const raw = JSON.stringify(body);
  return { method: "POST", body: raw, headers: { "paddle-signature": `ts=${ts};h1=${await hmacHex(SECRET, `${ts}:${raw}`)}` } };
}
const completed = (over: Record<string, unknown> = {}) => ({
  event_id: "evt_1",
  event_type: "transaction.completed",
  data: {
    id: "txn_1",
    customer_id: "ctm_1",
    currency_code: "USD",
    custom_data: { dw_vid: "v1", dw_sku: "pro_lifetime", dw_species: "wall" },
    items: [{ price: { id: "pri_life" } }],
    details: { totals: { grand_total: "4900" } },
    ...over,
  },
});

beforeEach(async () => {
  env = {
    DB: fakeD1(),
    SPECIES: "wall",
    ROUTER_KEY: "rk",
    LAB_KEY: "lk",
    PADDLE_CLIENT_TOKEN: "live_abc",
    PADDLE_ENV: "production",
    PADDLE_PRICES: JSON.stringify({ pro_monthly: "pri_month", pro_lifetime: "pri_life" }),
    PADDLE_WEBHOOK_SECRET: SECRET,
  };
  // The visitor was seen on an arm before paying (that arm gets the credit).
  await logEvent(env, { arm: "g3-abc", visitor: "v1", segment: "mobile", name: "js_seen" });
});

describe("signature", () => {
  it("accepts Paddle's format and rejects tampering, wrong secrets and stale timestamps", async () => {
    const ts = 1700000000;
    const h = await hmacHex(SECRET, `${ts}:{"a":1}`);
    expect(await verifyPaddle(SECRET, `ts=${ts};h1=${h}`, '{"a":1}', ts)).toBe(true);
    expect(await verifyPaddle(SECRET, `ts=${ts};h1=bad;h1=${h}`, '{"a":1}', ts)).toBe(true); // secret rotation
    expect(await verifyPaddle(SECRET, `ts=${ts};h1=${h}`, '{"a":2}', ts)).toBe(false);
    expect(await verifyPaddle("other", `ts=${ts};h1=${h}`, '{"a":1}', ts)).toBe(false);
    expect(await verifyPaddle(SECRET, `ts=${ts};h1=${h}`, '{"a":1}', ts + 3600)).toBe(false);
    expect(await verifyPaddle(SECRET, null, '{"a":1}', ts)).toBe(false);
  });
});

describe("webhook", () => {
  it("a completed payment grants the offer, credits the arm with revenue, once", async () => {
    expect((await call("/_dw/pay/webhook", await signed(completed()))).status).toBe(200);
    expect((await call("/_dw/pay/webhook", await signed(completed()))).status).toBe(200); // retry: no double count
    const ent = env.DB.raw.prepare("SELECT * FROM entitlements").all() as Record<string, unknown>[];
    expect(ent).toHaveLength(1);
    expect(ent[0]).toMatchObject({ visitor: "v1", sku: "pro_lifetime", status: "active", arm_id: "g3-abc", amount: 49 });
    const ev = env.DB.raw.prepare("SELECT arm_id, name, value, segment FROM events WHERE name = 'purchase'").all();
    expect(ev).toEqual([{ arm_id: "g3-abc", name: "purchase", value: 49, segment: "mobile" }]);
    expect(env.DB.raw.prepare("SELECT SUM(revenue) r FROM arm_hourly WHERE arm_id = 'g3-abc'").get()).toEqual({ r: 49 });
  });

  it("rejects unsigned or forged notifications", async () => {
    const forged = { method: "POST", body: JSON.stringify(completed()), headers: { "paddle-signature": "ts=1;h1=00" } };
    expect((await call("/_dw/pay/webhook", forged)).status).toBe(401);
    expect(env.DB.raw.prepare("SELECT COUNT(*) n FROM entitlements").get()).toEqual({ n: 0 });
  });

  it("ignores other species' payments (every domain receives every notification)", async () => {
    await call("/_dw/pay/webhook", await signed(completed({ custom_data: { dw_vid: "v1", dw_sku: "pro_lifetime", dw_species: "qr" } })));
    expect(env.DB.raw.prepare("SELECT COUNT(*) n FROM entitlements").get()).toEqual({ n: 0 });
  });

  it("renewals add revenue without custom data; cancellation and refunds revoke", async () => {
    await call("/_dw/pay/webhook", await signed(completed({ id: "txn_s1", subscription_id: "sub_1", custom_data: { dw_vid: "v1", dw_sku: "pro_monthly", dw_species: "wall" }, details: { totals: { grand_total: "900" } } })));
    const renewal = completed({ id: "txn_s2", subscription_id: "sub_1", custom_data: null, items: [{ price: { id: "pri_month" } }], details: { totals: { grand_total: "900" } } });
    await call("/_dw/pay/webhook", await signed({ ...renewal, event_id: "evt_2" }));
    expect(env.DB.raw.prepare("SELECT SUM(revenue) r FROM arm_hourly").get()).toEqual({ r: 18 });
    expect(env.DB.raw.prepare("SELECT COUNT(*) n FROM entitlements").get()).toEqual({ n: 1 });
    await call("/_dw/pay/webhook", await signed({ event_id: "evt_3", event_type: "subscription.canceled", data: { id: "sub_1", custom_data: { dw_species: "wall" } } }));
    expect(env.DB.raw.prepare("SELECT status FROM entitlements").get()).toEqual({ status: "canceled" });

    await call("/_dw/pay/webhook", await signed({ ...completed(), event_id: "evt_4" }));
    await call("/_dw/pay/webhook", await signed({ event_id: "evt_5", event_type: "adjustment.updated", data: { action: "refund", status: "approved", transaction_id: "txn_1", totals: { total: "4900" } } }));
    expect(env.DB.raw.prepare("SELECT status FROM entitlements WHERE txn_id = 'txn_1'").get()).toEqual({ status: "refunded" });
    expect(env.DB.raw.prepare("SELECT SUM(revenue) r FROM arm_hourly").get()).toEqual({ r: 18 });
  });

  it("sandbox payments unlock (for testing) but never count as revenue", async () => {
    env.PADDLE_ENV = "sandbox";
    await call("/_dw/pay/webhook", await signed(completed()));
    expect(env.DB.raw.prepare("SELECT status FROM entitlements").get()).toEqual({ status: "test" });
    expect(env.DB.raw.prepare("SELECT COUNT(*) n FROM events WHERE name = 'purchase'").get()).toEqual({ n: 0 });
  });
});

describe("browser flow", () => {
  it("c.js exposes offers with price labels and Paddle price ids; not ready until every offer has a price", async () => {
    const js = await (await call("/_dw/pay/c.js")).text();
    expect(js).toContain("pri_life");
    expect(js).toContain('"label":"$9.00 per month"');
    expect(payReady(env, cfg)).toBe(true);
    expect(payReady({ ...env, PADDLE_PRICES: JSON.stringify({ pro_monthly: "pri_month" }) }, cfg)).toBe(false);
    expect(payReady({ ...env, PADDLE_CLIENT_TOKEN: undefined }, cfg)).toBe(false);
    expect(priceLabel(cfg.offers![1])).toBe("$49.00 once");
  });

  it("simulated people never see Paddle: no token, a simulated checkout that grants a simulated entitlement", async () => {
    const sim = { visitor: "sim-x", arm: "g3-abc", segment: "desktop", sim: true, owner: false };
    const conf = clientConfig({ ...env, PADDLE_CLIENT_TOKEN: undefined }, cfg, sim, []);
    expect(conf).toMatchObject({ ready: true, sim: true, token: null });
    await call("/_dw/pay/start", { method: "POST", body: JSON.stringify({ sku: "pro_lifetime" }) }, sim);
    const r = await call("/_dw/pay/start", { method: "POST", body: JSON.stringify({ sku: "pro_lifetime", simConfirm: true }) }, sim);
    expect(r.headers.get("set-cookie")).toContain("dw_paid=1");
    const names = env.DB.raw.prepare("SELECT name, segment FROM events WHERE visitor = 'sim-x' ORDER BY id").all();
    expect(names).toEqual([{ name: "checkout_start", segment: "sim" }, { name: "purchase", segment: "sim" }]);
    expect(env.DB.raw.prepare("SELECT status FROM entitlements WHERE visitor='sim-x'").get()).toEqual({ status: "sim" });
  });

  it("checkout_start is a router-observed event; unknown offers are refused", async () => {
    expect((await call("/_dw/pay/start", { method: "POST", body: JSON.stringify({ sku: "nope" }) })).status).toBe(400);
    await call("/_dw/pay/start", { method: "POST", body: JSON.stringify({ sku: "pro_monthly" }) });
    await new Promise((r) => setTimeout(r, 5));
    expect(env.DB.raw.prepare("SELECT COUNT(*) n FROM visitor_firsts WHERE name = 'checkout_start'").get()).toEqual({ n: 1 });
  });

  it("status reports the purchase code; restore unlocks a second browser with it", async () => {
    await call("/_dw/pay/webhook", await signed(completed()));
    const st = (await (await call("/_dw/pay/status?sku=pro_lifetime")).json()) as { paid: boolean; code: string };
    expect(st.paid).toBe(true);
    expect(st.code).toMatch(/^[A-Z0-9]{5}-[A-Z0-9]{5}$/);
    const other = { ...visitor, visitor: "v2" };
    const bad = await call("/_dw/pay/restore", { method: "POST", body: new URLSearchParams({ code: "AAAAA-BBBBB" }) }, other);
    expect(await bad.text()).toContain("didn't match");
    const ok = await call("/_dw/pay/restore", { method: "POST", body: new URLSearchParams({ code: st.code.toLowerCase().replace("-", " ") }) }, other);
    expect(ok.headers.get("set-cookie")).toContain("dw_paid=1");
    expect(env.DB.raw.prepare("SELECT sku FROM entitlements WHERE visitor = 'v2'").get()).toEqual({ sku: "pro_lifetime" });
  });

  it("thanks page only continues to same-site paths", async () => {
    const html = await (await call("/_dw/pay/thanks?sku=pro_lifetime&next=//evil.com")).text();
    expect(html).toContain('href="/"');
    expect(html).not.toContain("evil.com");
  });
});
