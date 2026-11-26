// Darwinian router: sits on a species' public domain, assigns each visitor to a living arm
// (mutant) by Thompson sampling, proxies the request to that arm, and records fitness
// events server-side. Mutants never measure themselves; the router does.

import { chooseArm, bestByMean, type Arm, type ArmStat } from "./bandit";
import { matchEvents, type SpeciesConfig } from "./config";
import { aggregate } from "./aggregate";
import { lab, isOwner } from "./lab";
import { TRACKER_JS } from "./tracker";

export interface Env {
  DB: D1Database;
  SPECIES: string;
  ROUTER_KEY: string; // shared secret: mutants only serve requests carrying it
  LAB_KEY: string; // owner's read-only dashboard key
  GH_DISPATCH_TOKEN?: string; // set on one router only: it is the experiment's clock
  DISPATCH_REPO?: string;
  EVOLVE_EVERY_H?: string;
}

const BOT_RE =
  /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|embedly|quora link preview|whatsapp|telegrambot|discordbot|preview|headless|lighthouse|curl|wget|python-requests|httpx|go-http-client/i;
const YEAR = 60 * 60 * 24 * 365;

interface State {
  arms: Arm[]; // arms that real visitors may be assigned to
  all: Arm[]; // ...plus nursery arms, reachable only by simulated users
  stats: ArmStat[];
  cfg: SpeciesConfig | null;
  loadedAt: number;
}
let cache: State | null = null;

async function state(env: Env): Promise<State> {
  if (cache && Date.now() - cache.loadedAt < 30_000) return cache;
  const [arms, stats, cfgRow] = await Promise.all([
    env.DB.prepare(
      "SELECT arm_id, status, origin FROM arms WHERE species = ? AND status IN ('live','control','champion','nursery','guard')",
    )
      .bind(env.SPECIES)
      .all<Arm>(),
    env.DB.prepare(
      "SELECT arm_id, segment, trials, successes FROM arm_stats WHERE species = ?",
    )
      .bind(env.SPECIES)
      .all<ArmStat>(),
    env.DB.prepare("SELECT json FROM species_config WHERE species = ?")
      .bind(env.SPECIES)
      .first<{ json: string }>(),
  ]);
  cache = {
    // Nursery mutants and the previous champion kept as a rollback guard are reachable by simulated users only.
    arms: arms.results.filter((a) => a.status !== "nursery" && a.status !== "guard"),
    all: arms.results,
    stats: stats.results,
    cfg: cfgRow ? (JSON.parse(cfgRow.json) as SpeciesConfig) : null,
    loadedAt: Date.now(),
  };
  return cache;
}

function cookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function segmentOf(req: Request): string {
  return /Mobi|Android|iPhone|iPad/i.test(req.headers.get("user-agent") ?? "") ? "mobile" : "desktop";
}

function newId(): string {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(36).padStart(2, "0")).join("").slice(0, 16);
}

async function logEvent(
  env: Env,
  e: { arm: string; visitor: string; segment: string; name: string; path?: string; value?: number; props?: unknown },
) {
  await env.DB.prepare(
    "INSERT INTO events (ts, species, arm_id, visitor, segment, name, path, value, props) VALUES (?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      Date.now(),
      env.SPECIES,
      e.arm,
      e.visitor,
      e.segment,
      e.name,
      e.path ?? null,
      e.value ?? null,
      e.props ? JSON.stringify(e.props).slice(0, 500) : null,
    )
    .run();
  // Keep the incremental stats tables current (see migrations/0010). Never fail the event because of them.
  const t = Date.now();
  const counted = e.name === "pageview" || e.name === "http_5xx" || e.name === "purchase";
  const firsts = !counted || e.name === "purchase" ? !e.name.startsWith("c:") : false;
  const stmts = [];
  if (counted)
    stmts.push(
      env.DB.prepare(
        "INSERT INTO arm_hourly (species, arm_id, hour, requests, errors, revenue) VALUES (?,?,?,?,?,?) ON CONFLICT (species, arm_id, hour) DO UPDATE SET requests = requests + excluded.requests, errors = errors + excluded.errors, revenue = revenue + excluded.revenue",
      ).bind(env.SPECIES, e.arm, Math.floor(t / 3600_000), e.name === "purchase" ? 0 : 1, e.name === "http_5xx" ? 1 : 0, e.name === "purchase" ? e.value ?? 0 : 0),
    );
  if (firsts)
    stmts.push(
      env.DB.prepare("INSERT INTO visitor_firsts (species, arm_id, visitor, name, segment, ts) VALUES (?,?,?,?,?,?) ON CONFLICT (species, arm_id, visitor, name) DO UPDATE SET ts = excluded.ts").bind(env.SPECIES, e.arm, e.visitor, e.name, e.segment, t),
    );
  if (stmts.length) await env.DB.batch(stmts).catch(() => {});
}

async function proxy(req: Request, arm: Arm, env: Env, visitor: string): Promise<Response> {
  const inUrl = new URL(req.url);
  const target = new URL(inUrl.pathname + inUrl.search, arm.origin);
  const headers = new Headers(req.headers);
  headers.set("x-dw-key", env.ROUTER_KEY);
  headers.set("x-dw-arm", arm.arm_id);
  headers.set("x-dw-visitor", visitor);
  headers.set("x-forwarded-host", inUrl.host);
  headers.set("x-forwarded-proto", "https");
  headers.delete("cookie"); // arms get identity via x-dw-visitor; keep own cookies below
  const own = (req.headers.get("cookie") ?? "")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("dw_"))
    .join("; ");
  if (own) headers.set("cookie", own);
  return fetch(target.toString(), {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
    redirect: "manual",
  });
}

async function handleBeacon(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const c = cookies(req);
  const visitor = c.dw_vid;
  const armId = c.dw_arm;
  if (!visitor || !armId || BOT_RE.test(req.headers.get("user-agent") ?? "") || (await isOwner(req, env))) {
    return new Response(null, { status: 204 });
  }
  let body: { n?: string; path?: string; p?: unknown } = {};
  try {
    body = JSON.parse((await req.text()).slice(0, 2000));
  } catch {
    /* ignore */
  }
  // js_seen marks a real browser (bots rarely run JS); custom events are insight-only (prefixed c:).
  const name = body.n === "js_seen" ? "js_seen" : `c:${String(body.n ?? "unknown").slice(0, 40)}`;
  ctx.waitUntil(
    logEvent(env, { arm: armId, visitor, segment: segmentOf(req), name, path: body.path, props: body.p }),
  );
  return new Response(null, { status: 204 });
}

/** Token that marks a simulated user's browser (derived from the router key; the evolve loop does the same). */
export async function simToken(routerKey: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(routerKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("dw-sim"));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

// A simulated user (from the evolve loop) browsing a specific arm, including nursery arms.
// Their events are logged with segment 'sim' and never count as real visitors.
async function simulated(req: Request, env: Env, ctx: ExecutionContext, st: State, c: Record<string, string>): Promise<Response> {
  const url = new URL(req.url);
  const arm = st.all.find((a) => a.arm_id === c.dw_arm);
  if (!arm) return new Response("This simulated session's arm is gone.", { status: 410 });
  const visitor = c.dw_vid || "sim-unknown";
  const res = await proxy(req, arm, env, visitor);
  const isHtml = (res.headers.get("content-type") ?? "").includes("text/html");
  const tasks: Promise<unknown>[] = [];
  const log = (name: string) => tasks.push(logEvent(env, { arm: arm.arm_id, visitor, segment: "sim", name, path: url.pathname }));
  if (res.status >= 500) log("http_5xx");
  else if (isHtml && req.method === "GET") log("pageview");
  if (st.cfg) for (const rule of matchEvents(st.cfg, req.method, url, res.status)) log(rule.name);
  const credit = res.headers.get("x-dw-credit");
  if (credit && st.cfg) {
    const [name, owner] = credit.split(":");
    if (owner?.startsWith("sim-") && st.cfg.events.some((r) => r.credit === "header" && r.name === name)) {
      tasks.push(logEvent(env, { arm: arm.arm_id, visitor: owner, segment: "sim", name, path: url.pathname }));
    }
  }
  if (tasks.length) ctx.waitUntil(Promise.allSettled(tasks));
  const out = new Response(res.body, res);
  out.headers.delete("x-dw-credit");
  out.headers.set("cache-control", "private, no-store");
  return out;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/_dw/e" && req.method === "POST") return handleBeacon(req, env, ctx);
    if (url.pathname === "/_dw/t.js") {
      return new Response(TRACKER_JS, {
        headers: { "content-type": "application/javascript", "cache-control": "public, max-age=3600" },
      });
    }
    if (url.pathname === "/_dw/lab" || url.pathname.startsWith("/_dw/lab/")) return lab(req, env);
    if (url.pathname === "/_dw/health") return new Response("ok");
    // IndexNow ownership proof: /<key>.txt at the root (key derived from the lab key; the evolve loop does the same).
    if (/^\/[0-9a-f]{32}\.txt$/.test(url.pathname) && env.LAB_KEY) {
      const key = await indexNowKey(env.LAB_KEY);
      if (url.pathname === `/${key}.txt`) return new Response(key, { headers: { "content-type": "text/plain" } });
    }

    const st = await state(env);
    // Entry point for simulated users: /_dw/sim?t=<token>&arm=<id>&vid=<id>&next=/path
    if (url.pathname === "/_dw/sim") {
      if (!env.ROUTER_KEY || url.searchParams.get("t") !== (await simToken(env.ROUTER_KEY))) return new Response("Not found", { status: 404 });
      const clean = (v: string | null) => (v ?? "").replace(/[^\w-]/g, "").slice(0, 64);
      const next = url.searchParams.get("next") ?? "/";
      const res = new Response(null, { status: 303, headers: { location: next.startsWith("/") && !next.startsWith("//") ? next : "/" } });
      for (const [k, v] of [["dw_sim", url.searchParams.get("t")!], ["dw_arm", clean(url.searchParams.get("arm"))], ["dw_vid", "sim-" + clean(url.searchParams.get("vid"))]]) {
        // Persistent, so a simulated person returning "days later" (a restarted browser) is still recognised.
        res.headers.append("set-cookie", `${k}=${v}; Path=/; Max-Age=2592000; Secure; HttpOnly; SameSite=Lax`);
      }
      return res;
    }
    const c0 = cookies(req);
    if (c0.dw_sim && env.ROUTER_KEY && c0.dw_sim === (await simToken(env.ROUTER_KEY))) return simulated(req, env, ctx, st, c0);
    if (st.arms.length === 0) return new Response("Warming up. Please try again shortly.", { status: 503 });

    const ua = req.headers.get("user-agent") ?? "";
    const isBot = BOT_RE.test(ua);
    const passthrough = (st.cfg?.passthrough ?? []).some((p) => new RegExp(p).test(url.pathname));

    // Crawlers and shared infrastructure (embeds, robots, sitemaps) see the current best arm, untracked.
    if (isBot || passthrough) {
      const arm = bestByMean(st.arms, st.stats) ?? st.arms[0];
      const res = await proxy(req, arm, env, "anon");
      const credit = res.headers.get("x-dw-credit");
      if (!credit) return res;
      // e.g. a stranger leaves a testimonial on someone's public wall: credit the wall owner's arm.
      const [name, owner] = credit.split(":");
      if (st.cfg?.events.some((r) => r.credit === "header" && r.name === name) && owner) {
        ctx.waitUntil(creditOwner(env, name, owner, url.pathname));
      }
      const out = new Response(res.body, res);
      out.headers.delete("x-dw-credit");
      return out;
    }

    const c = cookies(req);
    const segment = segmentOf(req);
    let visitor = c.dw_vid;
    const setCookies: string[] = [];
    if (!visitor) {
      visitor = newId();
      setCookies.push(`dw_vid=${visitor}; Path=/; Max-Age=${YEAR}; Secure; HttpOnly; SameSite=Lax`);
    }
    let arm = st.arms.find((a) => a.arm_id === c.dw_arm);
    if (!arm) {
      arm =
        chooseArm(st.arms, st.stats, segment, { controlShare: st.cfg?.controlShare ?? 0.1 }) ?? st.arms[0];
      setCookies.push(`dw_arm=${arm.arm_id}; Path=/; Max-Age=${YEAR}; Secure; HttpOnly; SameSite=Lax`);
    }

    let res: Response;
    try {
      res = await proxy(req, arm, env, visitor);
    } catch (err) {
      ctx.waitUntil(logEvent(env, { arm: arm.arm_id, visitor, segment, name: "http_5xx", path: url.pathname }));
      return new Response("Something went wrong. Please refresh.", { status: 502 });
    }

    const isHtml = (res.headers.get("content-type") ?? "").includes("text/html");
    const tasks: Promise<unknown>[] = [];
    if (res.status >= 500) {
      tasks.push(logEvent(env, { arm: arm.arm_id, visitor, segment, name: "http_5xx", path: url.pathname }));
    } else if (isHtml && req.method === "GET") {
      tasks.push(logEvent(env, { arm: arm.arm_id, visitor, segment, name: "pageview", path: url.pathname, props: { src: sourceOf(req, url) } }));
    }
    if (st.cfg) {
      for (const rule of matchEvents(st.cfg, req.method, url, res.status)) {
        tasks.push(logEvent(env, { arm: arm.arm_id, visitor, segment, name: rule.name, path: url.pathname }));
      }
      // Multi-party credit (e.g. a testimonial submitted to someone's wall credits the wall owner's arm).
      const credit = res.headers.get("x-dw-credit");
      if (credit) {
        const [name, owner] = credit.split(":");
        const allowed = st.cfg.events.some((r) => r.credit === "header" && r.name === name);
        if (allowed && owner) tasks.push(creditOwner(env, name, owner, url.pathname));
      }
    }
    // The owner browsing (or previewing a mutant from the lab) never counts as a visitor.
    if (tasks.length && !(await isOwner(req, env))) ctx.waitUntil(Promise.allSettled(tasks));

    let out: Response = res;
    if (isHtml) {
      out = new HTMLRewriter()
        .on("body", {
          element(el) {
            el.append('<script src="/_dw/t.js" defer></script>', { html: true });
          },
        })
        .transform(res);
    }
    out = new Response(out.body, out);
    out.headers.delete("x-dw-credit");
    for (const sc of setCookies) out.headers.append("set-cookie", sc);
    out.headers.set("cache-control", isHtml ? "private, no-store" : out.headers.get("cache-control") ?? "private");
    return out;
  },

  async scheduled(ev: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    // Recount arm stats every 15 minutes (cheap now: it reads the small incremental tables).
    ctx.waitUntil(aggregate(env));
    // The heartbeat of evolution (only the router with GH_DISPATCH_TOKEN, i.e. qr, keeps the clock):
    // a breeding cycle every EVOLVE_EVERY_H hours, simulated users every hour, the growth loop once a day.
    const t = new Date(ev.scheduledTime);
    const every = Number(env.EVOLVE_EVERY_H ?? 6) || 6;
    const h = t.getUTCHours(), m = t.getUTCMinutes();
    const dispatch = (workflow: string) =>
      fetch(`https://api.github.com/repos/${env.DISPATCH_REPO ?? "darwinian-lab/engine"}/actions/workflows/${workflow}/dispatches`, {
        method: "POST",
        headers: { authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`, accept: "application/vnd.github+json", "user-agent": "darwinian-clock" },
        body: JSON.stringify({ ref: "main" }),
      }).then(async (r) => {
        if (!r.ok) console.log("dispatch failed", workflow, r.status, await r.text());
      });
    if (env.GH_DISPATCH_TOKEN) {
      if (h % every === 0 && m < 15) ctx.waitUntil(dispatch("evolve.yml"));
      if (m >= 15 && m < 30) ctx.waitUntil(dispatch("sims.yml"));
      if (h === 7 && m >= 30 && m < 45) ctx.waitUntil(dispatch("growth.yml"));
    }
  },
};

// Where a visit came from, normalised (AI assistants are first-class sources).
const SOURCES: [RegExp, string][] = [
  [/chatgpt\.com|chat\.openai\.com/, "chatgpt"], [/perplexity\.ai/, "perplexity"], [/gemini\.google\.com|bard\.google/, "gemini"],
  [/claude\.ai/, "claude"], [/copilot\.microsoft\.com|bing\.com\/chat/, "copilot"], [/(^|\.)google\./, "google"],
  [/(^|\.)bing\.com/, "bing"], [/duckduckgo\.com/, "duckduckgo"], [/yandex\./, "yandex"], [/reddit\.com/, "reddit"],
  [/news\.ycombinator\.com/, "hackernews"], [/(^|\.)x\.com|twitter\.com|t\.co$/, "x"], [/linkedin\.com/, "linkedin"], [/facebook\.com/, "facebook"],
];
export function sourceOf(req: Request, url: URL): string {
  const utm = url.searchParams.get("utm_source") ?? url.searchParams.get("ref");
  if (utm) return utm.toLowerCase().slice(0, 30);
  const ref = req.headers.get("referer");
  if (!ref) return "direct";
  let host = "";
  try { host = new URL(ref).hostname; } catch { return "unknown"; }
  if (host === url.hostname) return "internal";
  for (const [re, name] of SOURCES) if (re.test(host) || re.test(ref)) return name;
  return host.replace(/^www\./, "").slice(0, 40);
}

export async function indexNowKey(labKey: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${labKey}:indexnow`));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

async function creditOwner(env: Env, name: string, owner: string, path: string) {
  const row = await env.DB.prepare(
    "SELECT arm_id, segment FROM events WHERE species = ? AND visitor = ? AND name = 'js_seen' ORDER BY ts DESC LIMIT 1",
  )
    .bind(env.SPECIES, owner)
    .first<{ arm_id: string; segment: string }>();
  if (!row) return;
  await logEvent(env, { arm: row.arm_id, visitor: owner, segment: row.segment, name, path });
}
