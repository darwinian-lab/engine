#!/usr/bin/env node
// Real-visitor report: what actual people (not simulated ones, not bots) did on each site.
//   node evolve/report.mjs [--days 7]
// Writes markdown to stdout and to $GITHUB_STEP_SUMMARY when set.
import fs from "node:fs";
import path from "node:path";
import { d1 } from "./lib/d1.mjs";
import { loadConfig } from "./lib/config.mjs";

const args = process.argv.slice(2);
const cfg = loadConfig(args);
const db = d1(cfg, cfg.cloudflare.d1Engine);
const days = Number(args[args.indexOf("--days") + 1] || 7) || 7;
const since = Date.now() - days * 86400_000;
const day = 86400_000;
const out = [];
const p = (s = "") => out.push(s);

for (const sp of cfg.species) {
  const species = JSON.parse(fs.readFileSync(path.join(cfg.workdir, sp.repo, "species.json"), "utf8"));
  const goals = [...new Set((species.events ?? []).map((f) => f.name).filter((n) => !["checkout_start", "purchase"].includes(n)))];
  const R = "segment != 'sim'";
  p(`## ${species.brand?.name ?? sp.id} (${sp.domain})`);

  const daily = await db.all(
    `SELECT (ts / ${day}) d, COUNT(DISTINCT visitor) v, COUNT(*) pv FROM events WHERE species=? AND name='pageview' AND ${R} AND ts>? GROUP BY d ORDER BY d`, [sp.id, since]);
  const js = await db.all(`SELECT (ts / ${day}) d, COUNT(DISTINCT visitor) v FROM events WHERE species=? AND name='js_seen' AND ${R} AND ts>? GROUP BY d`, [sp.id, since]);
  const jsBy = Object.fromEntries(js.map((r) => [r.d, r.v]));
  const goalRows = await db.all(
    `SELECT (ts / ${day}) d, name, COUNT(DISTINCT visitor) v FROM events WHERE species=? AND ${R} AND ts>? AND name IN (${[...goals, "checkout_start", "purchase"].map(() => "?").join(",")}) GROUP BY d, name`,
    [sp.id, since, ...goals, "checkout_start", "purchase"]);
  const gBy = {};
  for (const r of goalRows) (gBy[r.d] ??= {})[r.name] = r.v;
  const cols = [...goals, "checkout_start", "purchase"];
  p(`| Day (UTC) | Visitors | Ran JS (likely human) | Page views | ${cols.join(" | ")} |`);
  p(`|---|---|---|---|${cols.map(() => "---").join("|")}|`);
  for (const r of daily) p(`| ${new Date(r.d * day).toISOString().slice(5, 10)} | ${r.v} | ${jsBy[r.d] ?? 0} | ${r.pv} | ${cols.map((c) => gBy[r.d]?.[c] ?? 0).join(" | ")} |`);

  const tot = await db.first(`SELECT COUNT(DISTINCT visitor) v FROM events WHERE species=? AND name='pageview' AND ${R} AND ts>?`, [sp.id, since]);
  const human = await db.first(`SELECT COUNT(DISTINCT visitor) v FROM events WHERE species=? AND name='js_seen' AND ${R} AND ts>?`, [sp.id, since]);
  const conv = await db.all(`SELECT name, COUNT(DISTINCT visitor) v FROM events WHERE species=? AND ${R} AND ts>? AND name IN (${cols.map(() => "?").join(",")}) GROUP BY name`, [sp.id, since, ...cols]);
  const rev = await db.first(`SELECT COALESCE(SUM(value),0) r FROM events WHERE species=? AND name='purchase' AND ${R} AND ts>?`, [sp.id, since]);
  const ret = await db.first(`SELECT COUNT(*) n FROM (SELECT visitor FROM events WHERE species=? AND name='pageview' AND ${R} AND ts>? GROUP BY visitor HAVING COUNT(DISTINCT ts / ${day}) > 1)`, [sp.id, since]);
  p("");
  p(`**${days} days:** ${tot?.v ?? 0} visitors, ${human?.v ?? 0} ran JavaScript, ${ret?.n ?? 0} came back on another day. ${conv.map((c) => `${c.name}: ${c.v}`).join(", ") || "no goal events"}. Revenue $${(rev?.r ?? 0).toFixed(2)}.`);

  const src = await db.all(
    `SELECT COALESCE(json_extract(props,'$.src'),'?') s, COUNT(DISTINCT visitor) v FROM events WHERE species=? AND name='pageview' AND ${R} AND ts>? AND COALESCE(json_extract(props,'$.src'),'') != 'internal' GROUP BY s ORDER BY v DESC LIMIT 12`, [sp.id, since]);
  p(`**Sources (visitors):** ${src.map((r) => `${r.s} ${r.v}`).join(", ") || "-"}`);
  const land = await db.all(
    `SELECT path, COUNT(DISTINCT visitor) v FROM events WHERE species=? AND name='pageview' AND ${R} AND ts>? AND COALESCE(json_extract(props,'$.src'),'') != 'internal' GROUP BY path ORDER BY v DESC LIMIT 10`, [sp.id, since]);
  p(`**Entry pages:** ${land.map((r) => `\`${r.path}\` ${r.v}`).join(", ") || "-"}`);
  const arms = await db.all(`SELECT arm_id, COUNT(DISTINCT visitor) v FROM events WHERE species=? AND name='pageview' AND ${R} AND ts>? GROUP BY arm_id ORDER BY v DESC LIMIT 10`, [sp.id, since]);
  p(`**Visitors by arm:** ${arms.map((r) => `${r.arm_id} ${r.v}`).join(", ") || "-"}`);
  p("");
}

const md = out.join("\n");
console.log(md);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
