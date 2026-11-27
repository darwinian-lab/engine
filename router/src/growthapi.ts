// Growth agent API: lets the acquisition agent (the Claude session that posts as the brand, in a real browser)
// work from the engine's growth queue and report what it posted, so every post is measured in real humans.
//   Authorization: Bearer <growth token>   (shown to the owner in the lab's Growth panel)
//   GET  /_dw/growth/queue            external ideas waiting to be posted, all species
//   POST /_dw/growth/mark             {id, action: "posted"|"skip", url?}       a queue item was posted / skipped
//   POST /_dw/growth/ref              {species, channel, target, note?, url?}   register your own post: returns a
//                                     ref code and tracked link (?ref=<code>); the item is live and measured
//   GET  /_dw/growth/stats?days=7     real humans (browsers that ran JS) per source and per tracked item, with
//                                     how many reached each site's goal event
import type { Env } from "./index";

const DAY = 86400_000;
const DOMAINS: Record<string, string> = { qr: "qrsthatlast.com", resume: "calmcv.com", wall: "kudospage.com" };
const CHANNELS = ["landing", "directory", "community", "social", "qa", "outreach", "launch"];

export async function growthToken(labKey: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(labKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("dw-growth-agent"));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v, null, 2), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export async function growthApi(req: Request, env: Env): Promise<Response> {
  if (!env.LAB_KEY) return new Response("Not found", { status: 404 });
  const auth = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!auth || auth !== (await growthToken(env.LAB_KEY))) return new Response("Not found", { status: 404 });
  const url = new URL(req.url);
  const sub = url.pathname.replace(/^\/_dw\/growth\/?/, "");
  const db = env.DB;

  if (sub === "queue" && req.method === "GET") {
    const { results } = await db
      .prepare("SELECT id, species, channel, target, target_url, angle, title, body, link, rules, created_at FROM growth_items WHERE kind='external' AND status='proposed' ORDER BY created_at DESC LIMIT 100")
      .all();
    return json({ items: results, note: "Rewrite drafts in the brand voice before posting. Keep each item's ref code in any link you post, then POST /_dw/growth/mark." });
  }

  if (sub === "mark" && req.method === "POST") {
    const b = (await req.json().catch(() => null)) as { id?: string; action?: string; url?: string } | null;
    if (!b?.id || !["posted", "skip"].includes(b.action ?? "")) return json({ ok: false, error: "need id and action posted|skip" }, 400);
    const t = Date.now();
    const r = b.action === "posted"
      ? await db.prepare("UPDATE growth_items SET status='live', live_at=?, target_url=COALESCE(?, target_url) WHERE id=? AND status='proposed'").bind(t, b.url || null, b.id).run()
      : await db.prepare("UPDATE growth_items SET status='skipped', retired_at=? WHERE id=? AND status='proposed'").bind(t, b.id).run();
    return json({ ok: (r.meta?.changes ?? 0) > 0 });
  }

  if (sub === "ref" && req.method === "POST") {
    const b = (await req.json().catch(() => null)) as { species?: string; channel?: string; target?: string; note?: string; url?: string; path?: string } | null;
    if (!b?.species || !DOMAINS[b.species]) return json({ ok: false, error: "species must be qr, resume or wall" }, 400);
    const channel = CHANNELS.includes(b.channel ?? "") ? b.channel! : "social";
    const id = `a${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 5)}`;
    const p = b.path && b.path.startsWith("/") ? b.path : "/";
    const link = `https://${DOMAINS[b.species]}${p}${p.includes("?") ? "&" : "?"}ref=${id}`;
    const t = Date.now();
    await db
      .prepare("INSERT INTO growth_items (id, species, channel, kind, target, target_url, angle, title, body, link, rules, status, created_at, live_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .bind(id, b.species, channel, "external", (b.target ?? "").slice(0, 200), b.url ?? null, (b.note ?? "").slice(0, 600), null, null, link, "posted by the acquisition agent", "live", t, t)
      .run();
    return json({ ok: true, ref: id, link });
  }

  if (sub === "stats" && req.method === "GET") {
    const days = Math.min(60, Math.max(1, Number(url.searchParams.get("days")) || 7));
    const since = Date.now() - days * DAY;
    const out: Record<string, unknown> = {};
    for (const sp of Object.keys(DOMAINS)) {
      const goals = await db.prepare("SELECT json FROM species_config WHERE species=?").bind(sp).first<{ json: string }>().catch(() => null);
      let events: string[] = [];
      try { events = (JSON.parse(goals?.json ?? "{}").events ?? []).map((e: { name: string }) => e.name); } catch {}
      const goalList = [...new Set([...events, "checkout_start", "purchase"])];
      // A human = a visitor whose browser ran the site's JavaScript. Source = the first non-internal pageview's src.
      const { results } = await db
        .prepare(
          `WITH humans AS (SELECT DISTINCT visitor FROM events WHERE species=?1 AND name='js_seen' AND segment!='sim' AND ts>?2),
                src AS (SELECT e.visitor, COALESCE(json_extract(e.props,'$.src'),'?') s, MIN(e.ts) t FROM events e JOIN humans h ON h.visitor=e.visitor
                        WHERE e.species=?1 AND e.name='pageview' AND e.ts>?2 AND COALESCE(json_extract(e.props,'$.src'),'') NOT IN ('internal') GROUP BY e.visitor),
                goal AS (SELECT DISTINCT visitor, name FROM events WHERE species=?1 AND segment!='sim' AND ts>?2 AND name IN (${goalList.map((_, i) => `?${i + 3}`).join(",")}))
           SELECT src.s source, COUNT(DISTINCT src.visitor) humans, ${goalList.map((g, i) => `COUNT(DISTINCT CASE WHEN goal.name=?${i + 3} THEN goal.visitor END) AS "${g.replace(/"/g, "")}"`).join(", ")}
           FROM src LEFT JOIN goal ON goal.visitor=src.visitor GROUP BY src.s ORDER BY humans DESC LIMIT 40`,
        )
        .bind(sp, since, ...goalList)
        .all();
      const { results: items } = await db
        .prepare("SELECT id, channel, target, target_url, status, live_at, humans, successes FROM growth_items WHERE species=? AND kind='external' AND status IN ('live','retired') ORDER BY live_at DESC LIMIT 60")
        .bind(sp)
        .all();
      out[sp] = { domain: DOMAINS[sp], goals: goalList, bySource: results, trackedItems: items };
    }
    return json({ days, note: "humans = real browsers that ran JS (bots and simulated people excluded). Tracked items are re-measured daily by the growth loop.", ...out });
  }

  return json({ ok: false, error: "unknown endpoint" }, 404);
}
