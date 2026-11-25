// Simulated people: AI agents with personas use an arm through the real router in real browsers
// (Playwright MCP), possibly over several sessions and devices, and report how it went.
// The router logs their requests with segment 'sim', so the same fitness events decide success.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { run, rid, log, extractJson } from "./util.mjs";
import { simPrompt } from "./prompts.mjs";
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
  const s = cfg.sims;
  const shimFile = path.join(workDir, "browser-shims.js");
  if (!fs.existsSync(shimFile)) fs.writeFileSync(shimFile, BROWSER_SHIMS);
  const args = mcpArgs(s, profileDir, device, shimFile);
  let cmd;
  if ((s.agent ?? "claude") === "codex") {
    const toml = "[" + args.map((a) => JSON.stringify(a)).join(",") + "]";
    const out = path.join(workDir, `codex-${rid(6)}.txt`);
    cmd = ["codex", "exec", "--skip-git-repo-check", "--ephemeral", "-s", "read-only",
      "-c", `mcp_servers.browser.command=${JSON.stringify(s.mcpCommand ?? "playwright-mcp")}`, "-c", `mcp_servers.browser.args=${toml}`, "-o", out, prompt];
    const r = await run(cmd[0], cmd.slice(1), { cwd: workDir, timeoutMs: (s.phaseMinutes ?? 10) * 60_000, agent: true, echoPrefix: `[${label} codex]` });
    const text = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : r.out;
    return { ...r, text };
  }
  const mcpFile = path.join(workDir, `mcp-${rid(6)}.json`);
  fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: { browser: { command: s.mcpCommand ?? "playwright-mcp", args } } }));
  const cargs = ["-p", prompt, "--model", s.model ?? "haiku", "--mcp-config", mcpFile, "--strict-mcp-config",
    "--allowedTools", "mcp__browser", "--max-turns", String(s.maxTurns ?? 45)];
  const r = await claudeStream({ args: cargs, cwd: workDir, label, timeoutMs: (s.phaseMinutes ?? 10) * 60_000, transcriptDir: path.join(cfg.workdir, ".tmp", "transcripts") });
  return { ...r, text: r.out };
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
      if (/hit your [\w -]*limit/i.test(r.out + r.err) || (r.code !== 0 && /usage limit|rate.?limit|limit reached|quota|credit balance/i.test(r.out + r.err))) {
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
  };
  await db.run(
    "INSERT INTO sim_runs (ts, species, arm_id, persona, device, outcome, stage_hit, done, rating, minutes, report) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    [row.ts, row.species, row.arm_id, row.persona, row.device, row.outcome, row.stage_hit, row.done, row.rating, row.minutes, JSON.stringify(row.report).slice(0, 60000)],
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
  for (let k = 0; k < budget; k++) {
    const needy = arms.filter((a) => count[a.arm_id] < minSims && !(a.status === "control" && count[a.arm_id] >= Math.ceil(minSims / 2)));
    let arm;
    if (needy.length) arm = needy.sort((x, y) => count[x.arm_id] - count[y.arm_id])[0];
    else {
      const pool = arms.filter((a) => a.status !== "control");
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
  const plan = allocate({ arms, simStats, budget, minSims, combined });
  // Choose personas: for each arm, the persona it has met least (ties broken by list order),
  // so arms end up compared on the same people.
  const jobs = plan.map(({ arm }) => {
    const pc = (personaCounts[arm.arm_id] ??= {});
    const persona = personas.slice().sort((a, b) => (pc[a.id] ?? 0) - (pc[b.id] ?? 0))[0];
    pc[persona.id] = (pc[persona.id] ?? 0) + 1;
    return { arm, persona };
  });
  const results = [];
  await pool(jobs, cfg.sims.concurrency ?? 4, async ({ arm, persona }) => {
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

/** Sim stats per arm over the last 14 days (errors excluded). */
export async function simStatsFor(db, spId) {
  const rows = await db.all(
    "SELECT arm_id, COUNT(*) t, SUM(outcome='success') s FROM sim_runs WHERE species=? AND ts>? AND outcome!='error' GROUP BY arm_id",
    [spId, Date.now() - 14 * 86400_000],
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
