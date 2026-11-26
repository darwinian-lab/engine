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
  // Growth queue: the owner marks an external item as posted (its window starts) or skips it.
  if (sub === "growth" && req.method === "POST") {
    if (req.headers.get("origin") && new URL(req.headers.get("origin")!).host !== url.host) return notFound();
    const body = (await req.json().catch(() => null)) as { id?: string; action?: string; url?: string } | null;
    if (!body?.id || !["posted", "skip", "unskip"].includes(body.action ?? "")) return json({ ok: false });
    const t = Date.now();
    if (body.action === "posted") await env.DB.prepare("UPDATE growth_items SET status='live', live_at=?, target_url=COALESCE(?, target_url) WHERE id=? AND status='proposed'").bind(t, body.url || null, body.id).run();
    if (body.action === "skip") await env.DB.prepare("UPDATE growth_items SET status='skipped', retired_at=? WHERE id=? AND status='proposed'").bind(t, body.id).run();
    if (body.action === "unskip") await env.DB.prepare("UPDATE growth_items SET status='proposed', retired_at=NULL WHERE id=? AND status='skipped'").bind(body.id).run();
    return json({ ok: true });
  }
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
  const [configs, state, arms, stats, journal, mediaRows, pbHistory, simRows, backlogRow, growthRows] = await Promise.all([
    q("SELECT species, json FROM species_config"),
    env.DB.prepare("SELECT * FROM species_state WHERE species = ?").bind(sp).first<any>(),
    q("SELECT * FROM arms WHERE species = ? ORDER BY created_at", sp),
    q("SELECT * FROM arm_stats WHERE species = ?", sp),
    q("SELECT ts, kind, arm_id, detail FROM journal WHERE species = ? OR species IS NULL ORDER BY ts DESC LIMIT 300", sp),
    safe(q("SELECT id, arm_id, kind, page, viewport, width, height, size, created_at FROM media WHERE species = ? ORDER BY id", sp), []),
    safe(q("SELECT ts, arm_id, pbest, trials, successes FROM pb_history WHERE species = ? AND ts > ? ORDER BY ts", sp, Date.now() - 60 * DAY), []),
    safe(q("SELECT id, ts, arm_id, persona, device, outcome, stage_hit, done, rating, minutes, report, agent, score FROM sim_runs WHERE species = ? AND ts > ? ORDER BY ts DESC LIMIT 600", sp, Date.now() - 30 * DAY), []),
    safe(env.DB.prepare("SELECT json, updated_at FROM backlog WHERE species = ?").bind(sp).first<any>(), null),
    safe(q("SELECT * FROM growth_items WHERE species = ? ORDER BY created_at DESC LIMIT 200", sp), []),
  ]);
  const pairRows: any[] = await safe(q("SELECT arm_a, arm_b, winner FROM sim_pairs WHERE species = ? AND ts > ?", sp, Date.now() - 14 * DAY), []);
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

  // Selection evidence = real visitors + simulated sessions (as the evolve loop weighs them, weight 1 until real traffic grows).
  const since14 = Date.now() - 14 * DAY;
  const simAgg: Record<string, { trials: number; successes: number; rated: number; ratingSum: number }> = {};
  for (const r of simRows as any[]) {
    if (r.outcome === "error") continue;
    const a = (simAgg[r.arm_id] ??= { trials: 0, successes: 0, rated: 0, ratingSum: 0 });
    if (r.ts > since14) {
      a.trials++;
      if (r.outcome === "success") a.successes++;
    }
    if (r.rating) { a.rated++; a.ratingSum += r.rating; }
  }
  const weeklyReal = (visitors as any[]).filter((v) => v.d * DAY > Date.now() - 7 * DAY).reduce((n, v) => n + v.n, 0);
  const lambda = 1 / (1 + weeklyReal / 50);
  const competing = arms.filter((a: any) => ["live", "champion", "nursery"].includes(a.status)).map((a: any) => a.arm_id);
  const combinedStats: ArmStat[] = competing.map((id: string) => {
    const r = (stats as any[]).find((s) => s.arm_id === id && s.segment === "all") ?? { trials: 0, successes: 0 };
    const m = simAgg[id] ?? { trials: 0, successes: 0 };
    return { arm_id: id, segment: "all", trials: r.trials + lambda * m.trials, successes: r.successes + lambda * m.successes };
  });
  // Show the last recorded measurement (stable across page loads); compute live only if none exists yet.
  const lastCycle = (pbHistory as any[]).length ? Math.max(...(pbHistory as any[]).map((h) => h.ts)) : 0;
  const recorded = Object.fromEntries((pbHistory as any[]).filter((h) => h.ts === lastCycle && competing.includes(h.arm_id)).map((h) => [h.arm_id, h.pbest]));
  const pb = Object.keys(recorded).length ? recorded : probBest(competing, combinedStats);

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
    simWeight: lambda,
    sims: Object.fromEntries(Object.entries(simAgg).map(([k, v]) => [k, { trials: v.trials, successes: v.successes, rating: v.rated ? v.ratingSum / v.rated : null }])),
    simRuns: (simRows as any[]).slice(0, 200).map((r) => {
      const rep = parse(r.report) ?? {};
      return {
        id: r.id, ts: r.ts, arm_id: r.arm_id, persona: r.persona, device: r.device, outcome: r.outcome, stage_hit: r.stage_hit, done: r.done, rating: r.rating, minutes: r.minutes,
        phases: (rep.phases ?? []).map((p: any) => ({ label: p.label, actor: p.actor, device: p.device, done: p.done, gave_up: p.gave_up, rating: p.rating, summary: p.summary, stuck: (p.stuck ?? []).slice(0, 5), wishes: (p.wishes ?? []).slice(0, 5), liked: (p.liked ?? []).slice(0, 3) })),
      };
    }),
    backlog: backlogRow ? { updated_at: backlogRow.updated_at, issues: parse(backlogRow.json) ?? [] } : null,
    growth: growthRows,
    quality: (() => {
      const by: Record<string, number[]> = {};
      for (const r of simRows as any[]) if (r.score != null && r.outcome !== "error" && r.ts > Date.now() - 14 * DAY) (by[r.arm_id] ??= []).push(r.score);
      return Object.fromEntries(Object.entries(by).map(([k, v]) => [k, { n: v.length, mean: v.reduce((a, b) => a + b, 0) / v.length }]));
    })(),
    pairs: (() => {
      const champ = (arms as any[]).find((a) => a.status === "champion")?.arm_id;
      const out: Record<string, { wins: number; losses: number; ties: number }> = {};
      for (const r of pairRows) {
        if (r.arm_b !== champ) continue;
        const p = (out[r.arm_a] ??= { wins: 0, losses: 0, ties: 0 });
        if (!r.winner) p.ties++;
        else if (r.winner === r.arm_a) p.wins++;
        else p.losses++;
      }
      return out;
    })(),
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
      revived_from: a.revived_from ?? null,
      crossed_from: a.crossed_from ?? null,
      issue: a.issue ?? null,
      graduated_at: a.graduated_at ?? null,
      final_score: a.final_score ?? null,
      prs: parse(a.prs),
      finalist_of: a.finalist_of ?? null,
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
