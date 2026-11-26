// Cron job (every 15 min): roll raw events into arm_stats for the bandit,
// and kill arms that are throwing errors (automatic rollback).

import type { Env } from "./index";
import type { SpeciesConfig } from "./config";

export const WINDOW_MS = 14 * 24 * 3600 * 1000;
// Before this moment a "visitor" only had to run JavaScript, so bots and site checkers counted as people.
// Real-visitor statistics start here (the moment the interaction-based tracker went live).
export const REAL_DATA_SINCE = Date.UTC(2026, 10, 25, 10, 3);
const KILL_MIN_REQUESTS = 50;
const KILL_ERROR_RATE = 0.05;

export async function aggregate(env: Env) {
  const sp = env.SPECIES;
  const now = Date.now();
  const since = Math.max(now - WINDOW_MS, REAL_DATA_SINCE);

  const cfgRow = await env.DB.prepare("SELECT json FROM species_config WHERE species = ?").bind(sp).first<{ json: string }>();
  if (!cfgRow) return;
  const cfg = JSON.parse(cfgRow.json) as SpeciesConfig;
  const st = await env.DB.prepare("SELECT stage FROM species_state WHERE species = ?").bind(sp).first<{ stage: number }>();
  const stage = cfg.stages[Math.min(st?.stage ?? 0, cfg.stages.length - 1)];

  const rows = await env.DB.prepare(
    `WITH seen AS (
       SELECT arm_id, visitor, segment FROM visitor_firsts
       WHERE species = ?1 AND name = 'js_seen' AND ts > ?2 AND segment != 'sim'
     ),
     won AS (
       SELECT arm_id, visitor FROM visitor_firsts
       WHERE species = ?1 AND name = ?3 AND ts > ?2
     )
     SELECT s.arm_id, s.segment,
            COUNT(DISTINCT s.visitor) AS trials,
            COUNT(DISTINCT w.visitor) AS successes
     FROM seen s LEFT JOIN won w ON w.arm_id = s.arm_id AND w.visitor = s.visitor
     GROUP BY s.arm_id, s.segment
     UNION ALL
     SELECT s.arm_id, 'all',
            COUNT(DISTINCT s.visitor),
            COUNT(DISTINCT w.visitor)
     FROM (SELECT DISTINCT arm_id, visitor FROM seen) s
     LEFT JOIN won w ON w.arm_id = s.arm_id AND w.visitor = s.visitor
     GROUP BY s.arm_id`,
  )
    .bind(sp, since, stage.event)
    .all<{ arm_id: string; segment: string; trials: number; successes: number }>();

  const health = await env.DB.prepare(
    `SELECT arm_id, SUM(requests) AS requests, SUM(errors) AS errors, SUM(revenue) AS revenue
     FROM arm_hourly WHERE species = ? AND hour >= ? GROUP BY arm_id`,
  )
    .bind(sp, Math.floor(since / 3600_000))
    .all<{ arm_id: string; requests: number; errors: number; revenue: number }>();
  const h = new Map(health.results.map((r) => [r.arm_id, r]));

  const stmts = [env.DB.prepare("DELETE FROM arm_stats WHERE species = ?").bind(sp)];
  for (const r of rows.results) {
    const hr = r.segment === "all" ? h.get(r.arm_id) : undefined;
    stmts.push(
      env.DB.prepare(
        "INSERT INTO arm_stats (species, arm_id, segment, trials, successes, revenue, requests, errors, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
      ).bind(sp, r.arm_id, r.segment, r.trials, r.successes, hr?.revenue ?? 0, hr?.requests ?? 0, hr?.errors ?? 0, now),
    );
  }
  await env.DB.batch(stmts);

  // Automatic rollback: an evolving arm erroring in the last hour dies; visitors get reassigned.
  const recent = await env.DB.prepare(
    `SELECT h.arm_id, SUM(h.requests) AS requests, SUM(h.errors) AS errors
     FROM arm_hourly h JOIN arms a ON a.species = h.species AND a.arm_id = h.arm_id
     WHERE h.species = ? AND h.hour >= ? AND a.status IN ('live','champion')
     GROUP BY h.arm_id`,
  )
    .bind(sp, Math.floor((now - 3600_000) / 3600_000))
    .all<{ arm_id: string; requests: number; errors: number }>();
  for (const r of recent.results) {
    if (r.requests >= KILL_MIN_REQUESTS && r.errors / r.requests > KILL_ERROR_RATE) {
      // Never kill the last evolving arm; the evolve loop handles that case.
      const alive = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM arms WHERE species = ? AND status IN ('live','champion')",
      )
        .bind(sp)
        .first<{ n: number }>();
      if ((alive?.n ?? 0) <= 1) continue;
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE arms SET status = 'dead', retired_at = ?, cause = ? WHERE species = ? AND arm_id = ?",
        ).bind(now, `error rate ${(r.errors / r.requests).toFixed(2)} over ${r.requests} requests`, sp, r.arm_id),
        env.DB.prepare("INSERT INTO journal (ts, species, kind, arm_id, detail) VALUES (?,?,?,?,?)").bind(
          now,
          sp,
          "death",
          r.arm_id,
          `auto-rollback: ${r.errors}/${r.requests} errors in the last hour`,
        ),
      ]);
    }
  }
}
