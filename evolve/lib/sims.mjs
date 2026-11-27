// Simulated people: AI agents with personas use an arm through the real router in real browsers
// (Playwright MCP), possibly over several sessions and devices, and report how it went.
// The router logs their requests with segment 'sim', so the same fitness events decide success.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { run, rid, log, extractJson, limitHit } from "./util.mjs";
import { simPrompt, pairPrompt } from "./prompts.mjs";
import { claudeStream } from "./stream.mjs";

export class SimRateLimited extends Error {}

export const simToken = (routerKey) => crypto.createHmac("sha256", routerKey).update("dw-sim").digest("hex");

export function loadPersonas(engineDir, speciesId) {
  const f = path.join(engineDir, "evolve", "sims", `${speciesId}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")).personas : [];
}

/** Run an async task list with a concurrency limit; stops scheduling new work after a SimRateLimited. */
async function pool(items, n, fn) {
  let i = 0;
  let stop = null;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length && !stop) {
      const item = items[i++];
      try {
        await fn(item);
      } catch (e) {
        if (e instanceof SimRateLimited) stop = e;
        else log(`sim crashed: ${e.message}`);
      }
    }
  });
  await Promise.all(workers);
  if (stop) throw stop;
}

// A headless browser has no print window, so window.print() would silently do nothing. Real browsers show one,
// so the simulated browser shows an equivalent: a print sheet whose "Save as PDF" saves the page.
const BROWSER_SHIMS = `(() => {
  const show = () => {
    if (document.getElementById("__dw_print")) return;
    const d = document.createElement("div");
    d.id = "__dw_print";
    d.setAttribute("role", "dialog");
    d.setAttribute("aria-label", "Print");
    d.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;font:16px system-ui";
    d.innerHTML = '<div style="background:#fff;color:#111;border-radius:12px;padding:20px;max-width:340px;width:90%"><h2 style="margin:0 0 6px;font-size:18px">Print</h2><p style="margin:0 0 14px">Destination: Save as PDF</p><button id="__dw_save" style="font:inherit;padding:8px 14px">Save as PDF</button> <button id="__dw_cancel" style="font:inherit;padding:8px 14px">Cancel</button></div>';
    document.body.appendChild(d);
    d.querySelector("#__dw_save").onclick = () => { d.innerHTML = '<div style="background:#fff;color:#111;border-radius:12px;padding:20px">Saved as PDF: ' + (document.title || "document").replace(/[<>]/g, "") + '.pdf <button id="__dw_ok" style="font:inherit;margin-left:8px">OK</button></div>'; d.querySelector("#__dw_ok").onclick = () => d.remove(); };
    d.querySelector("#__dw_cancel").onclick = () => d.remove();
  };
  window.print = () => { if (document.body) show(); else addEventListener("DOMContentLoaded", show); };
})();`;

function mcpArgs(s, profileDir, device, shimFile) {
  return [
    "--headless", "--init-script", shimFile, "--browser", s.browser ?? "chrome", "--user-data-dir", profileDir,
    ...(device === "mobile" ? ["--device", s.mobileDevice ?? "iPhone 15"] : ["--viewport-size", "1366,860"]),
    "--timeout-navigation", "30000", "--output-dir", path.join(profileDir, "..", "out"),
  ];
}

async function agent(cfg, prompt, profileDir, device, workDir, label = "sim") {
  return agentWith(cfg, prompt, [{ name: "browser", profileDir, device }], workDir, label);
}

let modelUnavailable = false;

/** Run one simulated person with one or more browsers (each its own MCP server and profile). */
async function agentWith(cfg, prompt, servers, workDir, label = "sim") {
  const s = cfg.sims;
  const shimFile = path.join(workDir, "browser-shims.js");
  if (!fs.existsSync(shimFile)) fs.writeFileSync(shimFile, BROWSER_SHIMS);
  if ((s.agent ?? "claude") === "codex") {
    const out = path.join(workDir, `codex-${rid(6)}.txt`);
    // Headless Codex cancels MCP calls that "need approval". Pre-approve only this sim's own browser servers;
    // the sandbox stays read-only.
    const mcp = servers.flatMap(({ name, profileDir, device }) => {
      const toml = "[" + mcpArgs(s, profileDir, device, shimFile).map((a) => JSON.stringify(a)).join(",") + "]";
      return ["-c", `mcp_servers.${name}.default_tools_approval_mode="approve"`, "-c", `mcp_servers.${name}.command=${JSON.stringify(s.mcpCommand ?? "playwright-mcp")}`, "-c", `mcp_servers.${name}.args=${toml}`,
        "-c", `mcp_servers.${name}.startup_timeout_sec=60`, "-c", `mcp_servers.${name}.tool_timeout_sec=120`];
    });
    // A cheaper model for the volume (settings sims.codexModel / codexEffort). If the account can't use it, fall
    // back to the default model for the rest of the run instead of losing every session.
    const model = s.codexModel && !modelUnavailable ? s.codexModel : null;
    const cmd = ["codex", "exec", "--skip-git-repo-check", "--ephemeral", "-s", "read-only", "-c", 'approval_policy="never"',
      ...(model ? ["-m", model] : []), ...(s.codexEffort ? ["-c", `model_reasoning_effort="${s.codexEffort}"`] : []), ...mcp, "-o", out, prompt];
    const r = await run(cmd[0], cmd.slice(1), { cwd: workDir, timeoutMs: (s.phaseMinutes ?? 10) * servers.length * 60_000, agent: true, echoPrefix: `[${label} codex]` });
    const text = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : r.out;
    if (model && r.code !== 0 && /model[^\n]{0,80}(not found|not supported|does not exist|unknown|unavailable|not available|invalid)/i.test(`${r.out}\n${r.err}`)) {
      modelUnavailable = true;
      console.log(`sims: model ${model} is not available on this account; using Codex's default model`);
      return agentWith(cfg, prompt, servers, workDir, label);
    }
    return { ...r, text };
  }
  const mcpFile = path.join(workDir, `mcp-${rid(6)}.json`);
  fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: Object.fromEntries(servers.map(({ name, profileDir, device }) => [name, { command: s.mcpCommand ?? "playwright-mcp", args: mcpArgs(s, profileDir, device, shimFile) }])) }));
  const cargs = ["-p", prompt, "--model", s.model ?? "haiku", "--mcp-config", mcpFile, "--strict-mcp-config",
    "--allowedTools", servers.map(({ name }) => `mcp__${name}`).join(","), "--max-turns", String((s.maxTurns ?? 45) * servers.length)];
  const r = await claudeStream({ args: cargs, cwd: workDir, label, timeoutMs: (s.phaseMinutes ?? 10) * servers.length * 60_000, transcriptDir: path.join(cfg.workdir, ".tmp", "transcripts") });
  return { ...r, text: r.out };
}

/**
 * Blinded side-by-side: one simulated person does the first task of their persona on a challenger and on a
 * reference arm (order randomised, each in its own browser) and says which they'd rather use.
 */
export async function runPair({ cfg, db, sp, challenger, reference, persona }) {
  const sid = rid(8);
  const base = path.join(cfg.workdir, ".tmp", "sim", `${sp.id}-pair-${sid}`);
  fs.mkdirSync(base, { recursive: true });
  const token = simToken(cfg.routerKey);
  const flip = Math.random() < 0.5;
  const [first, second] = flip ? [reference, challenger] : [challenger, reference];
  const device = persona.device;
  const entry = (arm, n) => `https://${sp.domain}/_dw/sim?t=${token}&arm=${encodeURIComponent(arm.arm_id)}&vid=${sid}v${n}&next=/`;
  const email = `${persona.id.split("-")[0]}${sid}+clerk_test@example.com`;
  let j = null;
  try {
    const prompt = pairPrompt({ persona, task: persona.phases[0].task, device, url1: entry(first, 1), url2: entry(second, 2), email });
    const r = await agentWith(cfg, prompt, [{ name: "site1", profileDir: path.join(base, "p1"), device }, { name: "site2", profileDir: path.join(base, "p2"), device }], base, `${sp.id} pair ${persona.id} ${challenger.arm_id} vs ${reference.arm_id}`);
    if (limitHit({ out: r.text ?? r.out, err: r.err, code: r.code })) throw new SimRateLimited((r.out + r.err).slice(-300));
    j = extractJson(r.text);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
  if (!j || ![0, 1, 2].includes(Number(j.prefer))) return null;
  const pick = Number(j.prefer) === 0 ? null : (Number(j.prefer) === 1) === !flip ? challenger.arm_id : reference.arm_id;
  await db.run("INSERT INTO sim_pairs (ts, species, arm_a, arm_b, persona, winner, strength, why, report, agent) VALUES (?,?,?,?,?,?,?,?,?,?)",
    [Date.now(), sp.id, challenger.arm_id, reference.arm_id, persona.id, pick, Number(j.strength) || 1, String(j.why ?? "").slice(0, 600), JSON.stringify({ flip, ...j }).slice(0, 8000), cfg.sims.agent ?? "claude"]);
  return { challenger: challenger.arm_id, reference: reference.arm_id, winner: pick, why: j.why };
}

/** Pairwise record of each challenger against a reference arm over the last 14 days. */
export async function pairStatsFor(db, spId, referenceId) {
  if (!referenceId) return {};
  const rows = await db.all("SELECT arm_a, winner, strength FROM sim_pairs WHERE species=? AND arm_b=? AND ts>?", [spId, referenceId, Date.now() - 14 * 86400_000]).catch(() => []);
  const out = {};
  for (const r of rows) {
    const p = (out[r.arm_a] ??= { wins: 0, losses: 0, ties: 0, n: 0 });
    p.n++;
    if (!r.winner) p.ties++;
    else if (r.winner === r.arm_a) p.wins++;
    else p.losses++;
  }
  return out;
}

/** Experience score per arm over the last 14 days: mean, standard error, count. */
export async function qualityFor(db, spId) {
  const rows = await db.all("SELECT arm_id, score FROM sim_runs WHERE species=? AND ts>? AND outcome!='error' AND score IS NOT NULL", [spId, Date.now() - 14 * 86400_000]).catch(() => []);
  const by = {};
  for (const r of rows) (by[r.arm_id] ??= []).push(r.score);
  return Object.fromEntries(Object.entries(by).map(([id, v]) => {
    const m = v.reduce((a, b) => a + b, 0) / v.length;
    const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, v.length - 1));
    return [id, { n: v.length, mean: m, se: sd / Math.sqrt(v.length) }];
  }));
}

/** What the router saw: pages viewed and time until the fitness event (not the agent's opinion). */
async function measureSession(db, spId, vids, started, stageEvent) {
  if (!vids.length) return { pageviews: 0, paths: 0, stageAfterPages: null, stageAfterSec: null };
  const rows = await db.all(`SELECT name, ts, path FROM events WHERE species=? AND ts>=? AND visitor IN (${vids.map(() => "?").join(",")}) ORDER BY ts`, [spId, started - 1000, ...vids]);
  const pv = rows.filter((r) => r.name === "pageview");
  const first = rows[0]?.ts ?? started;
  const hit = rows.find((r) => r.name === stageEvent);
  return {
    pageviews: pv.length,
    paths: new Set(pv.map((r) => r.path)).size,
    stageAfterPages: hit ? pv.filter((r) => r.ts <= hit.ts).length : null,
    stageAfterSec: hit ? Math.round((hit.ts - first) / 1000) : null,
  };
}

/**
 * Experience score 0-100 for one session: success (35), the persona's survey (45) and effort measured by the
 * router (20: pages it took to reach the fitness event). Finer than pass/fail, so arms separate with fewer sessions.
 */
export function experienceScore({ outcome, stageHit, phases, measured }) {
  const success = outcome === "success" ? 1 : stageHit ? 0.5 : 0;
  const per = phases
    .map((p) => {
      const v = Object.values(p.scores ?? {}).map(Number).filter((x) => x >= 1 && x <= 5);
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : Number(p.rating) || null;
    })
    .filter((x) => x);
  const survey = per.length ? (per.reduce((a, b) => a + b, 0) / per.length - 1) / 4 : success * 0.5;
  const pages = measured?.stageAfterPages;
  const effort = pages == null ? 0 : Math.max(0, Math.min(1, 1 - (pages - 1) / 8));
  return Math.round(100 * (0.35 * success + 0.45 * survey + 0.2 * effort) * 10) / 10;
}

/**
 * One simulated person using one arm, across all of the persona's phases.
 * Returns the stored sim_runs row (without id).
 */
export async function runSession({ cfg, db, sp, stageEvent, arm, persona }) {
  const s = cfg.sims;
  const sid = rid(8);
  const base = path.join(cfg.workdir, ".tmp", "sim", `${sp.id}-${sid}`);
  fs.mkdirSync(base, { recursive: true });
  const token = simToken(cfg.routerKey);
  const started = Date.now();
  const vids = [];
  const phases = [];
  let ownerMemory = "";
  let lastShare = "";
  let profile = 0;
  const email = `${persona.id.split("-")[0]}${sid}+clerk_test@example.com`; // Clerk test addresses accept code 424242
  try {
    for (let i = 0; i < persona.phases.length; i++) {
      const ph = persona.phases[i];
      const fresh = i === 0 || ph.browser === "new";
      if (fresh) profile = i;
      const device = ph.device ?? persona.device;
      const profileDir = path.join(base, `profile-${profile}`);
      const vid = `${sid}p${profile}`;
      if (fresh) vids.push(`sim-${vid}`);
      const url = fresh
        ? `https://${sp.domain}/_dw/sim?t=${token}&arm=${encodeURIComponent(arm.arm_id)}&vid=${vid}&next=/`
        : `https://${sp.domain}/`;
      const prompt = simPrompt({
        persona, phase: ph, actor: ph.actor, device, url, email,
        memory: ph.actor ? "" : ownerMemory,
        received: ph.actor ? lastShare : "",
        budget: s.actionsPerPhase ?? 25,
      });
      const r = await agent(cfg, prompt, profileDir, device, base, `${sp.id} sim ${persona.id}@${arm.arm_id} ${i + 1}/${persona.phases.length}`);
      if (limitHit({ out: r.text ?? r.out, err: r.err, code: r.code })) {
        throw new SimRateLimited((r.out + r.err).slice(-300));
      }
      const j = extractJson(r.text) ?? { done: false, gave_up: `agent returned no report (exit ${r.code}): ${(r.err || r.text).slice(-200)}` };
      phases.push({ label: ph.label, actor: ph.actor ?? null, device, ...j });
      if (!ph.actor) ownerMemory = [ownerMemory, j.remember].filter(Boolean).join("\n");
      if (j.share) lastShare = j.share;
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }

  // What did the router see this simulated person do?
  await new Promise((r) => setTimeout(r, 1500));
  const evs = vids.length
    ? await db.all(`SELECT DISTINCT name FROM events WHERE species=? AND ts>=? AND visitor IN (${vids.map(() => "?").join(",")})`, [sp.id, started - 1000, ...vids])
    : [];
  const names = evs.map((e) => e.name);
  const measured = await measureSession(db, sp.id, vids, started, stageEvent);
  const stageHit = names.includes(stageEvent) ? 1 : 0;
  const done = phases.length === persona.phases.length && phases.every((p) => p.done === true) ? 1 : 0;
  const ratings = phases.map((p) => Number(p.rating)).filter((x) => x >= 1 && x <= 5);
  const rating = ratings.length ? Math.round(ratings.reduce((a, b) => a + b, 0) / ratings.length) : null;
  const errored = phases.some((p) => String(p.gave_up ?? "").startsWith("agent returned no report"));
  const outcome = errored ? "error" : stageHit && done && (rating ?? 0) >= (s.happyAt ?? 4) ? "success" : "fail";
  const row = {
    ts: Date.now(), species: sp.id, arm_id: arm.arm_id, persona: persona.id, device: persona.device, outcome,
    stage_hit: stageHit, done, rating, minutes: +((Date.now() - started) / 60000).toFixed(1),
    report: { events: names, phases },
    measured,
  };
  row.score = experienceScore({ outcome, stageHit, phases, measured });
  await db.run(
    "INSERT INTO sim_runs (ts, species, arm_id, persona, device, outcome, stage_hit, done, rating, minutes, report, agent, score, measured) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    [row.ts, row.species, row.arm_id, row.persona, row.device, row.outcome, row.stage_hit, row.done, row.rating, row.minutes, JSON.stringify(row.report).slice(0, 60000), s.agent ?? "claude", row.score, JSON.stringify(measured)],
  );
  return row;
}

/**
 * Spread this cycle's simulated sessions over the arms: arms with few sessions first (so every arm gets judged),
 * the rest by Thompson sampling on the combined posterior (so the race at the top gets resolved).
 * Each arm cycles through personas so arms are compared on the same people.
 */
export function allocate({ arms, simStats, budget, minSims, combined, rng = Math.random }) {
  const plan = [];
  const count = Object.fromEntries(arms.map((a) => [a.arm_id, simStats[a.arm_id]?.trials ?? 0]));
  const sampleBeta = (s, f) => {
    // cheap approximation is fine for allocation
    const m = (s + 1) / (s + f + 2), v = (m * (1 - m)) / (s + f + 3);
    let u = 0; while (u === 0) u = rng();
    return m + Math.sqrt(v) * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
  };
  // The champion is the yardstick: it gets every 4th session so it keeps being measured alongside the newcomers
  // (otherwise Thompson sampling starves it and newcomers are compared with its old numbers).
  const champ = arms.find((a) => a.status === "champion");
  const guard = arms.find((a) => a.status === "guard");
  for (let k = 0; k < budget; k++) {
    const anchor = k % 4 === 0 ? champ : k % 8 === 2 ? guard : null;
    if (anchor) {
      count[anchor.arm_id]++;
      plan.push({ arm: anchor });
      continue;
    }
    const needy = arms.filter((a) => a.status !== "guard" && count[a.arm_id] < minSims && !(a.status === "control" && count[a.arm_id] >= Math.ceil(minSims / 2)));
    let arm;
    if (needy.length) arm = needy.sort((x, y) => count[x.arm_id] - count[y.arm_id])[0];
    else {
      const pool = arms.filter((a) => a.status !== "control" && a.status !== "guard");
      if (!pool.length) break;
      arm = pool
        .map((a) => {
          const c = combined[a.arm_id] ?? { trials: 0, successes: 0 };
          return { a, d: sampleBeta(c.successes, c.trials - c.successes) };
        })
        .sort((x, y) => y.d - x.d)[0].a;
    }
    count[arm.arm_id]++;
    plan.push({ arm });
  }
  return plan;
}

export async function runSims({ cfg, db, sp, stageEvent, arms, personas, budget, minSims, combined }) {
  if (!personas.length || !arms.length || budget <= 0) return [];
  const since = Date.now() - 14 * 86400_000;
  const rows = await db.all("SELECT arm_id, persona, outcome FROM sim_runs WHERE species=? AND ts>? AND outcome!='error'", [sp.id, since]);
  const simStats = {};
  const personaCounts = {};
  for (const r of rows) {
    const s = (simStats[r.arm_id] ??= { trials: 0, successes: 0 });
    s.trials++;
    if (r.outcome === "success") s.successes++;
    const pc = (personaCounts[r.arm_id] ??= {});
    pc[r.persona] = (pc[r.persona] ?? 0) + 1;
  }
  // Part of the budget goes to blinded side-by-side comparisons (each costs about two sessions): every challenger
  // against the champion, fewest comparisons first, and the champion against the rollback guard if there is one.
  const champ = arms.find((a) => a.status === "champion");
  const guard = arms.find((a) => a.status === "guard");
  const pairCounts = champ ? await pairStatsFor(db, sp.id, champ.arm_id) : {};
  const challengers = champ ? arms.filter((a) => a.status === "nursery" || a.status === "live").sort((x, y) => (pairCounts[x.arm_id]?.n ?? 0) - (pairCounts[y.arm_id]?.n ?? 0)) : [];
  const nPairs = champ ? Math.min(Math.floor((budget * (cfg.sims.pairShare ?? 0.3)) / 2), challengers.length + (guard ? 1 : 0)) : 0;
  // Tournament variants are also compared with each other, so the best version of an idea is found quickly.
  const groups = {};
  for (const a of arms) if (a.tournament && (a.status === "nursery" || a.status === "live")) (groups[a.tournament] ??= []).push(a);
  const h2h = [];
  if (Object.keys(groups).length) {
    const seen = {};
    for (const r of await db.all("SELECT arm_a, arm_b FROM sim_pairs WHERE species=? AND ts>?", [sp.id, since]).catch(() => [])) {
      const k = [r.arm_a, r.arm_b].sort().join("|");
      seen[k] = (seen[k] ?? 0) + 1;
    }
    for (const ms of Object.values(groups))
      for (let i = 0; i < ms.length; i++)
        for (let j = i + 1; j < ms.length; j++) {
          const n = seen[[ms[i].arm_id, ms[j].arm_id].sort().join("|")] ?? 0;
          // Alternate which variant is shown first.
          if (n < (cfg.tournaments?.maxPairs ?? 6)) h2h.push({ n, pair: n % 2 ? { challenger: ms[i], reference: ms[j] } : { challenger: ms[j], reference: ms[i] } });
        }
    h2h.sort((x, y) => x.n - y.n);
  }
  const nAll = Math.min(Math.floor((budget * (cfg.sims.pairShare ?? 0.3)) / 2) + Math.min(2, h2h.length), nPairs + h2h.length);
  const pairJobs = [];
  if (guard && nPairs) pairJobs.push({ pair: { challenger: champ, reference: guard } });
  const champQ = challengers.slice();
  while (pairJobs.length < nAll && (h2h.length || champQ.length)) {
    if (h2h.length) pairJobs.push({ pair: h2h.shift().pair });
    if (champQ.length && pairJobs.length < nAll) { const c = champQ.shift(); pairJobs.push({ pair: { challenger: c, reference: champ } }); }
  }
  const plan = allocate({ arms, simStats, budget: budget - 2 * pairJobs.length, minSims, combined });
  // Choose personas: for each arm, the persona it has met least (ties broken by list order),
  // so arms end up compared on the same people.
  const jobs = plan.map(({ arm }) => {
    const pc = (personaCounts[arm.arm_id] ??= {});
    const persona = personas.slice().sort((a, b) => (pc[a.id] ?? 0) - (pc[b.id] ?? 0))[0];
    pc[persona.id] = (pc[persona.id] ?? 0) + 1;
    return { arm, persona };
  });
  for (const pj of pairJobs) pj.persona = personas[Math.floor(Math.random() * personas.length)];
  jobs.unshift(...pairJobs);
  const results = [];
  results.pairs = [];
  await pool(jobs, cfg.sims.concurrency ?? 4, async ({ arm, persona, pair }) => {
    if (pair) {
      const p = await runPair({ cfg, db, sp, challenger: pair.challenger, reference: pair.reference, persona }).catch((e) => {
        if (e instanceof SimRateLimited) throw e;
        log(`[${sp.id}] pair failed: ${e.message}`);
        return null;
      });
      if (p) {
        log(`[${sp.id}] pair ${persona.id}: ${p.challenger} vs ${p.reference} -> ${p.winner ?? "no preference"}`);
        results.pairs.push(p);
      }
      return;
    }
    const r = await runSession({ cfg, db, sp, stageEvent, arm, persona });
    log(`[${sp.id}] sim ${persona.id} on ${arm.arm_id}: ${r.outcome} (stage ${r.stage_hit ? "hit" : "missed"}, done ${r.done}, rating ${r.rating ?? "-"}, ${r.minutes} min)`);
    results.push(r);
  }).catch((e) => {
    if (e instanceof SimRateLimited) {
      log(`[${sp.id}] simulations paused: usage limit`);
      results.rateLimited = true;
    } else throw e;
  });
  return results;
}

/**
 * Money per arm over the last 14 days (engine capability: payments): {real: {trials, starts, buys, revenue},
 * sims: {trials, starts, buys}}. Real trials are the arm's judged visitors (arm_stats); simulated trials are the
 * distinct simulated visitors who browsed it. Starts/buys are distinct visitors who opened a checkout / paid.
 */
export async function moneyStatsFor(db, spId) {
  const since = Date.now() - 14 * 86400_000;
  const [firsts, simVisitors, real, revenue] = await Promise.all([
    db.all(
      `SELECT arm_id, segment = 'sim' AS sim, name, COUNT(DISTINCT visitor) n FROM visitor_firsts
       WHERE species=? AND ts>? AND name IN ('checkout_start','purchase') GROUP BY arm_id, segment = 'sim', name`,
      [spId, since],
    ),
    db.all(`SELECT arm_id, COUNT(DISTINCT visitor) n FROM events WHERE species=? AND ts>? AND segment='sim' AND name='pageview' GROUP BY arm_id`, [spId, since]),
    db.all("SELECT arm_id, trials, revenue FROM arm_stats WHERE species=? AND segment='all'", [spId]),
    db.all("SELECT arm_id, SUM(revenue) r FROM arm_hourly WHERE species=? AND hour>=? GROUP BY arm_id", [spId, Math.floor(since / 3600_000)]),
  ]);
  const out = {};
  const at = (id) => (out[id] ??= { real: { trials: 0, starts: 0, buys: 0, revenue: 0 }, sims: { trials: 0, starts: 0, buys: 0 } });
  for (const r of real) at(r.arm_id).real.trials = r.trials ?? 0;
  for (const r of revenue) at(r.arm_id).real.revenue = r.r ?? 0;
  for (const r of simVisitors) at(r.arm_id).sims.trials = r.n;
  for (const r of firsts) at(r.arm_id)[r.sim ? "sims" : "real"][r.name === "purchase" ? "buys" : "starts"] = r.n;
  return out;
}

/** Sim stats per arm over the last 14 days (errors excluded). */
export async function simStatsFor(db, spId, agent = null) {
  // Only sessions from the current simulator count (see migrations/0007_sim_agent.sql).
  const rows = await db.all(
    `SELECT arm_id, COUNT(*) t, SUM(outcome='success') s FROM sim_runs WHERE species=? AND ts>? AND outcome!='error'${agent ? " AND agent=?" : ""} GROUP BY arm_id`,
    [spId, Date.now() - 14 * 86400_000, ...(agent ? [agent] : [])],
  );
  return Object.fromEntries(rows.map((r) => [r.arm_id, { trials: r.t, successes: r.s ?? 0 }]));
}

/** Short digest of what simulated people said about an arm, for the mutation prompt. */
export async function simDigest(db, spId, armId, limit = 12) {
  const rows = await db.all("SELECT persona, outcome, rating, report FROM sim_runs WHERE species=? AND arm_id=? ORDER BY ts DESC LIMIT ?", [spId, armId, limit]);
  return rows
    .map((r) => {
      let rep = {};
      try { rep = JSON.parse(r.report); } catch {}
      const ph = rep.phases ?? [];
      const stuck = ph.flatMap((p) => p.stuck ?? []).slice(0, 3);
      const wishes = ph.flatMap((p) => p.wishes ?? []).slice(0, 3);
      return `- ${r.persona}: ${r.outcome}, rating ${r.rating ?? "-"}. ${ph.map((p) => p.summary).filter(Boolean).join(" ").slice(0, 300)}${stuck.length ? ` Stuck: ${stuck.join("; ")}.` : ""}${wishes.length ? ` Wished: ${wishes.join("; ")}.` : ""}`;
    })
    .join("\n");
}
