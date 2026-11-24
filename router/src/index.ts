// Darwinian router: sits on a species' public domain, assigns each visitor to a living arm
// (mutant) by Thompson sampling, proxies the request to that arm, and records fitness
// events server-side. Mutants never measure themselves; the router does.

import { chooseArm, bestByMean, type Arm, type ArmStat } from "./bandit";
import { matchEvents, type SpeciesConfig } from "./config";
import { aggregate } from "./aggregate";
import { lab } from "./lab";
import { TRACKER_JS } from "./tracker";

export interface Env {
  DB: D1Database;
  SPECIES: string;
  ROUTER_KEY: string; // shared secret: mutants only serve requests carrying it
  LAB_KEY: string; // owner's read-only dashboard key
}

const BOT_RE =
  /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|embedly|quora link preview|whatsapp|telegrambot|discordbot|preview|headless|lighthouse|curl|wget|python-requests|httpx|go-http-client/i;
const YEAR = 60 * 60 * 24 * 365;

interface State {
  arms: Arm[];
  stats: ArmStat[];
  cfg: SpeciesConfig | null;
  loadedAt: number;
}
let cache: State | null = null;

async function state(env: Env): Promise<State> {
  if (cache && Date.now() - cache.loadedAt < 30_000) return cache;
  const [arms, stats, cfgRow] = await Promise.all([
    env.DB.prepare(
      "SELECT arm_id, status, origin FROM arms WHERE species = ? AND status IN ('live','control','champion')",
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
    arms: arms.results,
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
  if (!visitor || !armId || BOT_RE.test(req.headers.get("user-agent") ?? "")) {
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

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/_dw/e" && req.method === "POST") return handleBeacon(req, env, ctx);
    if (url.pathname === "/_dw/t.js") {
      return new Response(TRACKER_JS, {
        headers: { "content-type": "application/javascript", "cache-control": "public, max-age=3600" },
      });
    }
    if (url.pathname === "/_dw/lab") return lab(req, env);
    if (url.pathname === "/_dw/health") return new Response("ok");

    const st = await state(env);
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
      tasks.push(logEvent(env, { arm: arm.arm_id, visitor, segment, name: "pageview", path: url.pathname }));
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
    if (tasks.length) ctx.waitUntil(Promise.allSettled(tasks));

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

  async scheduled(_ev: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(aggregate(env));
  },
};

async function creditOwner(env: Env, name: string, owner: string, path: string) {
  const row = await env.DB.prepare(
    "SELECT arm_id, segment FROM events WHERE species = ? AND visitor = ? AND name = 'js_seen' ORDER BY ts DESC LIMIT 1",
  )
    .bind(env.SPECIES, owner)
    .first<{ arm_id: string; segment: string }>();
  if (!row) return;
  await logEvent(env, { arm: row.arm_id, visitor: owner, segment: row.segment, name, path });
}
