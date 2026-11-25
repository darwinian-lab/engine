// Owner's read-only window into one species: /_dw/lab?key=LAB_KEY

import type { Env } from "./index";
import { probBest, type ArmStat } from "./bandit";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export async function lab(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  if (!env.LAB_KEY || url.searchParams.get("key") !== env.LAB_KEY) return new Response("Not found", { status: 404 });
  const sp = env.SPECIES;
  const [arms, stats, journal, state, sources] = await Promise.all([
    env.DB.prepare("SELECT * FROM arms WHERE species = ? ORDER BY created_at DESC LIMIT 60").bind(sp).all<any>(),
    env.DB.prepare("SELECT * FROM arm_stats WHERE species = ?").bind(sp).all<ArmStat & { revenue: number; requests: number; errors: number }>(),
    env.DB.prepare("SELECT * FROM journal WHERE species = ? OR species IS NULL ORDER BY ts DESC LIMIT 80").bind(sp).all<any>(),
    env.DB.prepare("SELECT * FROM species_state WHERE species = ?").bind(sp).first<any>(),
    env.DB.prepare(
      "SELECT json_extract(props,'$.src') AS src, COUNT(DISTINCT visitor) AS n FROM events WHERE species = ? AND name = 'pageview' AND ts > ? GROUP BY src ORDER BY n DESC LIMIT 20",
    ).bind(sp, Date.now() - 7 * 86400_000).all<any>(),
  ]);
  const alive = arms.results.filter((a) => ["live", "champion", "control"].includes(a.status));
  const pb = probBest(
    alive.filter((a) => a.status !== "control").map((a) => a.arm_id),
    stats.results,
  );
  const all = (id: string) => stats.results.find((s) => s.arm_id === id && s.segment === "all");
  const row = (a: any) => {
    const s = all(a.arm_id);
    const rate = s && s.trials ? ((100 * s.successes) / s.trials).toFixed(1) + "%" : "–";
    return `<tr class="${esc(a.status)}"><td><b>${esc(a.arm_id)}</b></td><td>${esc(a.status)}</td><td>${a.generation}</td><td>${esc(a.parent)}</td>
      <td>${s?.trials ?? 0}</td><td>${s?.successes ?? 0}</td><td>${rate}</td><td>${pb[a.arm_id] !== undefined ? (100 * pb[a.arm_id]).toFixed(0) + "%" : ""}</td>
      <td>$${(s?.revenue ?? 0).toFixed(2)}</td><td>${s?.errors ?? 0}/${s?.requests ?? 0}</td><td class="h">${esc(a.hypothesis)}${a.cause ? `<br><i>${esc(a.cause)}</i>` : ""}</td></tr>`;
  };
  const html = `<!doctype html><meta name=viewport content="width=device-width"><meta name=robots content=noindex>
<title>Lab · ${esc(sp)}</title>
<style>body{font:14px system-ui;margin:24px;color:#111}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #eee;padding:6px;text-align:left;vertical-align:top}
.control{background:#f4f4ff}.champion{background:#effaf0}.retired,.dead{color:#999}.h{max-width:420px;font-size:12px}h2{margin-top:32px}</style>
<h1>🧬 ${esc(sp)} — generation ${state?.generation ?? 0}, stage ${state?.stage ?? 0}</h1>
<h2>Arms</h2><table><tr><th>arm</th><th>status</th><th>gen</th><th>parent</th><th>visitors</th><th>successes</th><th>rate</th><th>P(best)</th><th>revenue</th><th>errors</th><th>hypothesis</th></tr>
${arms.results.map(row).join("")}</table>
<h2>Where visitors came from (7 days)</h2><table>${sources.results.map((r) => `<tr><td>${esc(r.src ?? "unknown")}</td><td>${r.n}</td></tr>`).join("") || "<tr><td>No visitors yet</td></tr>"}</table>
<h2>Journal</h2><table>${journal.results
    .map((j) => `<tr><td>${new Date(j.ts).toISOString().slice(0, 16).replace("T", " ")}</td><td>${esc(j.kind)}</td><td>${esc(j.arm_id)}</td><td>${esc(j.detail)}</td></tr>`)
    .join("")}</table>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
