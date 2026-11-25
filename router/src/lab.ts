// The owner's window into the experiment.
//   /_dw/lab?key=LAB_KEY   sets an owner cookie, then serves the dashboard at /_dw/lab
//   /_dw/lab/api           JSON for the dashboard (any species: they share one database)
//   /_dw/lab/media/:id     a screenshot or video of an arm
//   /_dw/lab/visit?arm=ID  browse this domain as that arm (owner visits are never counted)

import type { Env } from "./index";
import { probBest, type ArmStat } from "./bandit";
import LAB_HTML from "./labui.html";

const DAY = 86400_000;
const YEAR_S = 60 * 60 * 24 * 365;

export async function ownerToken(labKey: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(labKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("dw-lab-owner"));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function isOwner(req: Request, env: Env): Promise<boolean> {
  if (!env.LAB_KEY) return false;
  const m = (req.headers.get("cookie") ?? "").match(/(?:^|;\s*)dw_owner=([0-9a-f]{64})/);
  return !!m && m[1] === (await ownerToken(env.LAB_KEY));
}

const json = (v: unknown) =>
  new Response(JSON.stringify(v), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
const notFound = () => new Response("Not found", { status: 404 });
const parse = (s: unknown) => {
  if (typeof s !== "string" || !s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

export async function lab(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  if (!env.LAB_KEY) return notFound();
  // ?key=LAB_KEY, or ?t=<owner token> (handoff between the species' domains), is traded for a cookie
  // so the secret doesn't stay in history, screenshots or the address bar.
  const keyParam = url.searchParams.get("key");
  const tParam = url.searchParams.get("t");
  if (keyParam !== null || tParam !== null) {
    const token = await ownerToken(env.LAB_KEY);
    if (keyParam !== env.LAB_KEY && tParam !== token) return notFound();
    url.searchParams.delete("key");
    url.searchParams.delete("t");
    const res = new Response(null, { status: 303, headers: { location: url.pathname + url.search } });
    res.headers.append("set-cookie", `dw_owner=${token}; Path=/; Max-Age=${YEAR_S}; Secure; HttpOnly; SameSite=Lax`);
    return res;
  }
  if (!(await isOwner(req, env))) return notFound();

  const sub = url.pathname.replace(/^\/_dw\/lab\/?/, "");
  if (sub === "") {
    return new Response(LAB_HTML, {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" },
    });
  }
  if (sub === "api") return json(await snapshot(env, url.searchParams.get("species") || env.SPECIES));
  if (sub.startsWith("media/")) return media(req, env, Number(sub.slice(6)));
  if (sub === "visit") {
    const arm = url.searchParams.get("arm") ?? "";
    const res = new Response(null, { status: 303, headers: { location: "/" } });
    res.headers.append("set-cookie", arm ? `dw_arm=${arm.replace(/[^\w-]/g, "")}; Path=/; Secure; HttpOnly; SameSite=Lax` : "dw_arm=; Path=/; Max-Age=0");
    return res;
  }
  return notFound();
}

async function media(req: Request, env: Env, id: number): Promise<Response> {
  if (!Number.isInteger(id)) return notFound();
  const m = await env.DB.prepare("SELECT mime FROM media WHERE id = ?").bind(id).first<{ mime: string }>();
  if (!m) return notFound();
  const chunks = await env.DB.prepare("SELECT data FROM media_chunk WHERE media_id = ? ORDER BY seq").bind(id).all<{ data: string }>();
  const bin = atob(chunks.results.map((c) => c.data).join(""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const headers: Record<string, string> = {
    "content-type": m.mime,
    "cache-control": "private, max-age=31536000, immutable",
    "accept-ranges": "bytes",
  };
  // Safari only plays video that can be fetched in ranges.
  const range = req.headers.get("range")?.match(/bytes=(\d*)-(\d*)/);
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, bytes.length - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
    if (start >= bytes.length) return new Response(null, { status: 416, headers: { "content-range": `bytes */${bytes.length}` } });
    return new Response(bytes.slice(start, end + 1), {
      status: 206,
      headers: { ...headers, "content-range": `bytes ${start}-${end}/${bytes.length}` },
    });
  }
  return new Response(bytes, { headers });
}

export async function snapshot(env: Env, sp: string) {
  const since30 = Date.now() - 30 * DAY;
  const q = (sql: string, ...b: unknown[]) => env.DB.prepare(sql).bind(...b).all<any>().then((r) => r.results);
  const safe = <T>(p: Promise<T>, fallback: T) => p.catch(() => fallback); // tables may not exist yet
  const [configs, state, arms, stats, journal, mediaRows, pbHistory] = await Promise.all([
    q("SELECT species, json FROM species_config"),
    env.DB.prepare("SELECT * FROM species_state WHERE species = ?").bind(sp).first<any>(),
    q("SELECT * FROM arms WHERE species = ? ORDER BY created_at", sp),
    q("SELECT * FROM arm_stats WHERE species = ?", sp),
    q("SELECT ts, kind, arm_id, detail FROM journal WHERE species = ? OR species IS NULL ORDER BY ts DESC LIMIT 300", sp),
    safe(q("SELECT id, arm_id, kind, page, viewport, width, height, size, created_at FROM media WHERE species = ? ORDER BY id", sp), []),
    safe(q("SELECT ts, arm_id, pbest, trials, successes FROM pb_history WHERE species = ? AND ts > ? ORDER BY ts", sp, Date.now() - 60 * DAY), []),
  ]);
  const cfg = parse(configs.find((c: any) => c.species === sp)?.json) ?? {};
  const stageIdx = state?.stage ?? 0;
  const stage = cfg.stages?.[Math.min(stageIdx, (cfg.stages?.length ?? 1) - 1)];
  const stageEvent = stage?.event ?? "__none__";

  const [visitors, successes, sources] = await Promise.all([
    q("SELECT ts / 86400000 AS d, arm_id, COUNT(DISTINCT visitor) AS n FROM events WHERE species = ? AND ts > ? AND name = 'js_seen' GROUP BY d, arm_id", sp, since30),
    q("SELECT ts / 86400000 AS d, arm_id, COUNT(DISTINCT visitor) AS n FROM events WHERE species = ? AND ts > ? AND name = ? GROUP BY d, arm_id", sp, since30, stageEvent),
    q(
      "SELECT ts / 86400000 AS d, json_extract(props,'$.src') AS src, COUNT(DISTINCT visitor) AS n FROM events WHERE species = ? AND ts > ? AND name = 'pageview' GROUP BY d, src",
      sp,
      since30,
    ),
  ]);

  const competing = arms.filter((a: any) => a.status === "live" || a.status === "champion").map((a: any) => a.arm_id);
  const pb = probBest(competing, stats as ArmStat[]);

  const byArm: Record<string, Record<string, any>> = {};
  for (const s of stats) (byArm[s.arm_id] ??= {})[s.segment] = { trials: s.trials, successes: s.successes, revenue: s.revenue, requests: s.requests, errors: s.errors };

  return {
    now: Date.now(),
    handoff: await ownerToken(env.LAB_KEY),
    current: sp,
    repo: `darwinian-lab/species-${sp}`,
    species: configs.map((c: any) => {
      const j = parse(c.json) ?? {};
      return { id: c.species, name: j.brand?.name ?? c.species, domain: j.domain ?? null };
    }),
    state: {
      generation: state?.generation ?? 0,
      stage: stageIdx,
      stages: (cfg.stages ?? []).map((s: any) => ({ name: s.name, event: s.event, describe: s.describe ?? null })),
    },
    arms: arms.map((a: any) => ({
      arm_id: a.arm_id,
      status: a.status,
      generation: a.generation,
      parent: a.parent,
      git_ref: a.git_ref,
      hypothesis: a.hypothesis,
      mutation: a.mutation ?? null,
      size: a.size ?? null,
      diffstat: parse(a.diffstat),
      audit: parse(a.audit),
      personas: parse(a.personas),
      created_at: a.created_at,
      retired_at: a.retired_at,
      cause: a.cause,
    })),
    stats: byArm,
    pb,
    pbHistory,
    daily: { visitors, successes },
    sources,
    journal,
    media: mediaRows,
  };
}
