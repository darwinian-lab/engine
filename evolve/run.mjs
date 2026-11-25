#!/usr/bin/env node
// The evolution loop. Run on a schedule (e.g. every 3 hours):
//   node evolve/run.mjs [--config /etc/darwinian/config.json] [--species qr] [--dry-run]
//
// For each species: publish its config, advance the fitness stage, select (promote / retire),
// then breed new mutants up to the traffic-adjusted population size.

import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { d1 } from "./lib/d1.mjs";
import { loadConfig } from "./lib/config.mjs";
import { mutationSize, decideNursery, NURSERY_DEFAULTS } from "./lib/select.mjs";
import { gate } from "./lib/gates.mjs";
import { mutationPrompt, repairPrompt, auditPrompt, auditFixPrompt, curatorPrompt, ideationPrompt } from "./lib/prompts.mjs";
import { loadPersonas, runSims, simStatsFor, simDigest } from "./lib/sims.mjs";
import { pickRevivals, isRevivable } from "./lib/seeds.mjs";
import { ensureLabels, listIssues, backlogText, applyCuration, createIssue, comment, closeIssue, parseImplements } from "./lib/issues.mjs";
import { ENGINE_DIR } from "./lib/config.mjs";
import { run, must, expand, rid, log, lock, extractJson, readJson, stripHtml } from "./lib/util.mjs";
import { capture, storeMedia } from "./lib/shots.mjs";

// In GitHub Actions, surface fatal errors as annotations (readable without opening the log).
const annotate = (e) => {
  if (process.env.GITHUB_ACTIONS) console.log(`::error::${String(e?.stack ?? e).slice(0, 1500).replace(/%/g, "%25").replace(/\r/g, "").replace(/\n/g, "%0A")}`);
  console.error(e);
  process.exit(1);
};
process.on("uncaughtException", annotate);
process.on("unhandledRejection", annotate);


const args = process.argv.slice(2);
const argv = (k) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const cfg = loadConfig(args);
if (!cfg.cloudflare.apiToken || !cfg.cloudflare.d1Engine || !cfg.routerKey) {
  console.error("Not configured yet: run bootstrap first (and set the CLOUDFLARE_* / DW_* secrets).");
  process.exit(1);
}
const DRY = args.includes("--dry-run") || cfg.dryRun;
// --sim-only: run simulated sessions (optionally --sims N) without breeding or selecting. For testing the harness.
const SIM_ONLY = args.includes("--sim-only");
const db = d1(cfg, cfg.cloudflare.d1Engine);
const cfEnv = { CLOUDFLARE_API_TOKEN: cfg.cloudflare.apiToken, CLOUDFLARE_ACCOUNT_ID: cfg.cloudflare.accountId };
const now = () => Date.now();
const ghNotice = (title, msg) => {
  if (process.env.GITHUB_ACTIONS) console.log(`::notice title=${title}::${String(msg).slice(0, 1800).replace(/%/g, "%25").replace(/\r/g, "").replace(/\n/g, "%0A")}`);
};
const journal = (species, kind, arm_id, detail) => (ghNotice(`${species ?? "engine"} ${kind} ${arm_id ?? ""}`, detail),
  db.run("INSERT INTO journal (ts, species, kind, arm_id, detail) VALUES (?,?,?,?,?)", [now(), species, kind, arm_id, String(detail).slice(0, 4000)]));

class RateLimited extends Error {}

/** A tiny async mutex: parallel spawns share one git repository and one Codex login. */
function mutex() {
  let last = Promise.resolve();
  return (fn) => {
    const next = last.then(fn, fn);
    last = next.catch(() => {});
    return next;
  };
}
const gitLock = mutex();
const codexLock = mutex();

async function claude(wt, promptText, model) {
  fs.mkdirSync(path.join(wt, ".dw"), { recursive: true });
  fs.writeFileSync(path.join(wt, ".dw/prompt.md"), promptText);
  const cmd = expand(cfg.commands.claude, {
    prompt: "Read the file .dw/prompt.md and carry out the instructions in it exactly. Work autonomously until done.",
    model,
  });
  const r = await run(cmd[0], cmd.slice(1), { cwd: wt, timeoutMs: (cfg.timeouts?.mutateMin ?? 40) * 60_000 });
  const text = r.out + r.err;
  if (/rate.?limit|usage limit|limit reached|quota/i.test(text) && r.code !== 0) throw new RateLimited(text.slice(-500));
  return r;
}

function codex(promptText, tag) {
  return codexLock(() => codexRaw(promptText, tag));
}
async function codexRaw(promptText, tag) {
  const out = path.join(cfg.workdir, ".tmp", `codex-${tag}-${rid(6)}.txt`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const promptFile = out.replace(/\.txt$/, ".prompt.md");
  fs.writeFileSync(promptFile, promptText);
  const cmd = expand(cfg.commands.codex, { out, prompt: `Read ${promptFile} and answer exactly as it asks. Do not modify any files.` });
  const r = await run(cmd[0], cmd.slice(1), { cwd: path.dirname(out), timeoutMs: 15 * 60_000 });
  const text = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : r.out;
  fs.rmSync(promptFile, { force: true });
  fs.rmSync(out, { force: true });
  return extractJson(text);
}

// Lab schema (migrations/0002_lab.sql) is applied idempotently on every run.
async function ensureSchema() {
  const dir = path.join(ENGINE_DIR, "migrations");
  const sql = fs.readdirSync(dir).filter((f) => f >= "0002").sort().map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join(";\n").replace(/--.*$/gm, "");
  for (const stmt of sql.split(";").map((x) => x.trim()).filter(Boolean)) {
    try {
      await db.run(stmt);
    } catch (e) {
      if (!/duplicate column/i.test(e.message)) log(`schema: ${e.message.slice(0, 200)}`);
    }
  }
}

/** git diff --numstat → [{path, add, del}] */
function numstat(out) {
  return out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [a, d, ...p] = l.split("\t");
      return { path: p.join("\t"), add: Number(a) || 0, del: Number(d) || 0 };
    })
    .slice(0, 80);
}

/** Photograph a deployed arm for the lab. Never fails the caller. */
async function photograph(sp, armId, origin) {
  if (DRY || !origin) return;
  try {
    const dir = path.join(cfg.workdir, ".tmp", "shots", `${sp.id}-${armId}`);
    const items = await capture({ origin, routerKey: cfg.routerKey, pages: sp.screenPages ?? ["/"], outDir: dir });
    const n = await storeMedia(db, sp.id, armId, items);
    await db.run("UPDATE arms SET shot_at=? WHERE species=? AND arm_id=?", [now(), sp.id, armId]);
    fs.rmSync(dir, { recursive: true, force: true });
    log(`[${sp.id}] photographed ${armId}: ${n} files`);
  } catch (e) {
    log(`[${sp.id}] photographing ${armId} failed: ${e.message}`);
  }
}

/** Mutants that never lived still belong in the fossil record (status 'stillborn'). */
async function stillborn(sp, armId, parent, st, cause, extra = {}) {
  if (DRY) return;
  await db.run(
    `INSERT OR IGNORE INTO arms (species, arm_id, origin, status, generation, parent, git_ref, hypothesis, created_at, retired_at, cause, mutation, size, diffstat, audit, personas, shot_at, revived_from, revivable, died_gen, final_score, issue)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [sp.id, armId, "", "stillborn", st.generation + 1, parent.arm_id, null, (extra.mutation ?? "").split("\n").filter(Boolean).slice(0, 3).join(" ").slice(0, 600), now(), now(), cause.slice(0, 1500),
      extra.mutation ?? null, extra.size ?? null, extra.diffstat ? JSON.stringify(extra.diffstat) : null, extra.audit ? JSON.stringify(extra.audit) : null,
      extra.personas ? JSON.stringify(extra.personas) : null, extra.shot ? now() : null,
      extra.revivedFrom ?? null, isRevivable(cause) ? 1 : 0, st.generation, 0.3, parseImplements(extra.mutation)],
  ).catch((e) => log(`stillborn record failed: ${e.message}`));
}

/** Fill in lab details for arms born before the lab recorded them; photograph living arms without photos. */
async function backfill(sp, repo) {
  if (DRY) return;
  const missing = await db.all("SELECT arm_id, git_ref FROM arms WHERE species=? AND mutation IS NULL AND git_ref LIKE 'fossil/%'", [sp.id]);
  for (const a of missing) {
    const body = await run("git", ["log", "-1", "--format=%B", a.git_ref], { cwd: repo });
    if (body.code !== 0) continue;
    const mutation = body.out.replace(/\r/g, "").split("\n").slice(1).join("\n").trim() || body.out.trim();
    const ns = await run("git", ["diff", "--numstat", `${a.git_ref}^`, a.git_ref], { cwd: repo });
    await db.run("UPDATE arms SET mutation=?, diffstat=? WHERE species=? AND arm_id=?", [mutation, JSON.stringify(numstat(ns.out)), sp.id, a.arm_id]);
  }
  const unshot = await db.all("SELECT arm_id, origin FROM arms WHERE species=? AND status IN ('live','champion','control','nursery') AND shot_at IS NULL AND origin != ''", [sp.id]);
  for (const a of unshot) await photograph(sp, a.arm_id, a.origin);
}

async function fetchText(origin, p) {
  try {
    const res = await fetch(origin + p, { headers: { "x-dw-key": cfg.routerKey, "x-dw-visitor": "evolve-screen" } });
    return `--- ${p} (${res.status}) ---\n` + stripHtml(await res.text()).slice(0, 4000);
  } catch (e) {
    return `--- ${p} (fetch failed: ${e}) ---`;
  }
}

async function deployArm(sp, wt, armId) {
  const name = `sp-${sp.id}-${armId}`;
  await must("npx", ["wrangler", "deploy", "--name", name, "--var", `ROUTER_KEY:${cfg.routerKey}`], { cwd: wt, env: cfEnv, timeoutMs: 5 * 60_000 });
  return { name, origin: `https://${name}.${cfg.cloudflare.workersSubdomain}.workers.dev` };
}

async function deleteWorker(name) {
  if (DRY) return;
  await run("npx", ["wrangler", "delete", "--name", name, "--force"], { cwd: cfg.workdir, env: cfEnv, timeoutMs: 120_000 });
}

function lineageText(rows) {
  return rows
    .map((a) => `- [${a.status}] ${a.arm_id} (gen ${a.generation}, parent ${a.parent ?? "-"}): ${(a.hypothesis ?? "").replace(/\s+/g, " ").slice(0, 300)}${a.cause ? ` → ${a.cause}` : ""}`)
    .join("\n");
}

async function insights(spId) {
  const since = now() - 7 * 86400_000;
  const [custom, pages, seg, srcs, probes] = await Promise.all([
    db.all("SELECT name, COUNT(*) n FROM events WHERE species=? AND ts>? AND name LIKE 'c:%' GROUP BY name ORDER BY n DESC LIMIT 12", [spId, since]),
    db.all("SELECT path, COUNT(*) n FROM events WHERE species=? AND ts>? AND name='pageview' GROUP BY path ORDER BY n DESC LIMIT 12", [spId, since]),
    db.all("SELECT segment, COUNT(DISTINCT visitor) n FROM events WHERE species=? AND ts>? AND name='js_seen' GROUP BY segment", [spId, since]),
    db.all("SELECT json_extract(props,'$.src') src, COUNT(DISTINCT visitor) n FROM events WHERE species=? AND ts>? AND name='pageview' GROUP BY src ORDER BY n DESC LIMIT 12", [spId, since]),
    db.all("SELECT detail FROM journal WHERE species=? AND kind='probe' ORDER BY ts DESC LIMIT 6", [spId]),
  ]);
  return [
    `Visitors last 7 days by device: ${seg.map((s) => `${s.segment} ${s.n}`).join(", ") || "none"}`,
    `Top pages: ${pages.map((p) => `${p.path} (${p.n})`).join(", ") || "none"}`,
    `Custom events: ${custom.map((c) => `${c.name.slice(2)} (${c.n})`).join(", ") || "none"}`,
    `Traffic sources (visitors): ${srcs.map((r) => `${r.src ?? "unknown"} ${r.n}`).join(", ") || "none"}`,
    `AI search visibility probes (latest): ${probes.map((p) => p.detail).join(" | ") || "none yet"}`,
  ].join("\n");
}

async function spawnOne(sp, repo, species, brief, st, parent, siblings, ctx = {}) {
  const { backlog = "", revival = null } = ctx;
  const armId = `g${st.generation + 1}-${rid()}`;
  let ref = parent.git_ref || "main";
  const wt = path.join(cfg.workdir, "wt", `${sp.id}-${armId}`);
  const size = mutationSize();
  log(`[${sp.id}] spawning ${armId} from ${parent.arm_id} (${size}${revival ? `, revival of ${revival.root}` : ""})`);
  await gitLock(() => must("git", ["worktree", "add", "-b", `arm/${armId}`, wt, ref], { cwd: repo }));
  const cleanup = async () => {
    await gitLock(() => run("git", ["worktree", "remove", "--force", wt], { cwd: repo }));
  };
  try {
    // Protected files (charter, brief, species.json, config, migrations) belong to the owner and live on main.
    // Sync them into the child before mutating, so engine-side updates reach every new lineage.
    for (const p of species.protected ?? []) {
      await run("git", ["checkout", "origin/main", "--", p.replace(/\/$/, "")], { cwd: wt });
    }
    if ((await run("git", ["status", "--porcelain"], { cwd: wt })).out.trim()) {
      await must("git", ["-c", "user.name=darwinian", "-c", "user.email=evolve@darwinian.local", "commit", "-q", "-am", "sync protected files from main"], { cwd: wt });
      await run("git", ["add", "-A"], { cwd: wt });
      await run("git", ["-c", "user.name=darwinian", "-c", "user.email=evolve@darwinian.local", "commit", "-q", "-m", "sync new protected files"], { cwd: wt });
    }
    ref = (await must("git", ["rev-parse", "HEAD"], { cwd: wt })).trim();
    fs.symlinkSync(path.join(repo, "node_modules"), path.join(wt, "node_modules"));
    fs.appendFileSync(path.join(repo, ".git", "info", "exclude"), "\n.dw/\nnode_modules\n");

    const stage = species.stages[Math.min(st.stage, species.stages.length - 1)];
    const lineage = await db.all(
      "SELECT * FROM arms WHERE species=? AND status NOT IN ('control','stillborn') ORDER BY created_at DESC LIMIT 25",
      [sp.id],
    );
    const prompt = mutationPrompt({
      species,
      brief,
      stage: stage.name,
      stageEvent: stage.describe ?? `trigger "${stage.event}"`,
      size,
      lineage: lineageText(lineage),
      siblings: siblings.map((s) => `- ${s.arm_id}: ${(s.hypothesis ?? "").slice(0, 200)}`).join("\n"),
      insights: await insights(sp.id),
      protectedFiles: species.protected ?? [],
      backlog,
      simFeedback: await simDigest(db, sp.id, parent.arm_id),
      revival,
    });
    const first = await claude(wt, prompt, cfg.models.mutate);
    if (first.code !== 0) {
      log(`[${sp.id}] claude exited ${first.code}: ${(first.err || first.out).slice(-300)}`);
      ghNotice(`${sp.id} claude exit ${first.code}`, (first.err || first.out).slice(-1500));
    }

    const pkgChanged = (await run("git", ["diff", "--quiet", ref, "--", "package.json"], { cwd: wt })).code !== 0;
    if (pkgChanged) {
      fs.rmSync(path.join(wt, "node_modules"), { force: true, recursive: true });
      await must("npm", ["install", "--no-audit", "--no-fund"], { cwd: wt, timeoutMs: 10 * 60_000 });
    }

    const repairRounds = cfg.repairRounds ?? 3;
    const auditFixRounds = cfg.auditFixRounds ?? 3;
    let g = await gate(wt, ref, species);
    for (let i = 1; !g.ok && g.changes.length > 0 && i <= repairRounds; i++) {
      log(`[${sp.id}] ${armId} failed gates, repair round ${i}/${repairRounds}`);
      await claude(wt, repairPrompt(g.failure), cfg.models.repair);
      g = await gate(wt, ref, species);
    }
    const mutationSoFar = () => (fs.existsSync(path.join(wt, "MUTATION.md")) ? fs.readFileSync(path.join(wt, "MUTATION.md"), "utf8") : null);
    const stagedStat = async () => numstat((await run("git", ["diff", "--cached", "--numstat", ref], { cwd: wt })).out);
    if (!g.ok) {
      await journal(sp.id, "reject", armId, `failed gates: ${g.failure.slice(0, 1500)}`);
      await stillborn(sp, armId, parent, st, `failed the build/test gates: ${g.failure.slice(0, 600)}`, { mutation: mutationSoFar(), size, diffstat: await stagedStat(), revivedFrom: revival?.root });
      return null;
    }

    // Independent audit (Codex). One chance to fix blocking findings, then a second audit.
    const runAudit = async () => {
      const diff = (await run("git", ["diff", "--cached", ref], { cwd: wt })).out;
      const mutationText = fs.readFileSync(path.join(wt, "MUTATION.md"), "utf8");
      return codex(auditPrompt({ charter: fs.readFileSync(path.join(wt, "CHARTER.md"), "utf8"), diff, mutation: mutationText }), "audit");
    };
    let audit = await runAudit();
    const auditRounds = [];
    // Review → fix → review again, up to auditFixRounds times, before the mutant is declared stillborn.
    for (let i = 1; audit && audit.verdict !== "pass" && (audit.violations ?? []).length && i <= auditFixRounds; i++) {
      auditRounds.push(audit.violations);
      ghNotice(`${sp.id} ${armId} audit round ${i}`, JSON.stringify(audit.violations));
      await claude(wt, auditFixPrompt(audit.violations, i, auditRounds.slice(0, -1)), cfg.models.repair);
      g = await gate(wt, ref, species);
      for (let k = 1; !g.ok && k <= repairRounds; k++) {
        await claude(wt, repairPrompt(g.failure), cfg.models.repair);
        g = await gate(wt, ref, species);
      }
      audit = g.ok ? await runAudit() : { verdict: "fail", violations: ["gates failed after fixing audit findings: " + g.failure.slice(0, 500)] };
    }
    if (!audit || audit.verdict !== "pass") {
      await journal(sp.id, "reject", armId, `audit ${audit ? "failed" : "unavailable"}: ${JSON.stringify(audit?.violations ?? []).slice(0, 1500)}`);
      await stillborn(sp, armId, parent, st, `rejected by the independent audit: ${(audit?.violations ?? ["auditor unavailable"]).join("; ").slice(0, 900)}`, {
        mutation: mutationSoFar(), size, diffstat: await stagedStat(), audit: { summary: audit?.summary ?? null, notes: audit?.notes ?? [], rounds: auditRounds }, revivedFrom: revival?.root,
      });
      return null;
    }
    const mutation = fs.readFileSync(path.join(wt, "MUTATION.md"), "utf8");

    await must("git", ["-c", "user.name=darwinian", "-c", "user.email=evolve@darwinian.local", "commit", "-q", "-m", `${armId}: ${mutation.split("\n")[0].replace(/^#\s*/, "")}\n\n${mutation}`], { cwd: wt });
    const tag = `fossil/${sp.id}/${armId}`;
    await gitLock(() => must("git", ["tag", tag], { cwd: wt }));
    const diffstat = numstat((await run("git", ["diff", "--numstat", "HEAD^", "HEAD"], { cwd: wt })).out);
    const auditInfo = { summary: audit.summary ?? null, notes: audit.notes ?? [], rounds: auditRounds };
    if (DRY) {
      log(`[${sp.id}] dry-run: ${armId} passed gates + audit; not deploying`);
      return null;
    }

    const newMigrations = g.changes.some((c) => c.status === "A" && c.path.startsWith("migrations/"));
    if (newMigrations) {
      await must("npx", ["wrangler", "d1", "migrations", "apply", `sp-${sp.id}`, "--remote"], { cwd: wt, env: cfEnv, timeoutMs: 5 * 60_000 });
    }
    const { name, origin } = await deployArm(sp, wt, armId);

    // A fresh *.workers.dev deployment can answer 404 for a little while: wait until it serves the home page.
    for (let i = 0; i < 18; i++) {
      const r = await fetch(origin + "/", { headers: { "x-dw-key": cfg.routerKey } }).catch(() => null);
      if (r && r.status !== 404 && r.status < 500) break;
      await new Promise((res) => setTimeout(res, 5000));
    }
    // Photos for the lab. Simulated people judge it next, in the nursery.
    await photograph(sp, armId, origin);

    await gitLock(() => must("git", ["push", "-q", "origin", `arm/${armId}`, tag], { cwd: wt }));
    const hypothesis = mutation.replace(/\r/g, "").split("\n").filter(Boolean).slice(0, 3).join(" ").slice(0, 600);
    const issueNo = parseImplements(mutation);
    await db.run(
      `INSERT INTO arms (species, arm_id, origin, status, generation, parent, git_ref, hypothesis, created_at, mutation, size, diffstat, audit, personas, shot_at, revived_from, revivable, issue)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(species, arm_id) DO UPDATE SET origin=excluded.origin, status='nursery', git_ref=excluded.git_ref, hypothesis=excluded.hypothesis,
         mutation=excluded.mutation, size=excluded.size, diffstat=excluded.diffstat, audit=excluded.audit, revived_from=excluded.revived_from, issue=excluded.issue`,
      [sp.id, armId, origin, "nursery", st.generation + 1, parent.arm_id, tag, hypothesis, now(), mutation, size, JSON.stringify(diffstat), JSON.stringify(auditInfo), null, now(), revival?.root ?? null, 1, issueNo],
    );
    await journal(sp.id, "spawn", armId, `${size} ${revival ? `revival of ${revival.root} (death ${revival.deaths}), ` : ""}mutation of ${parent.arm_id}${issueNo ? `, implements #${issueNo}` : ""}: ${audit.summary ?? ""}`);
    if (issueNo) await comment(`${cfg.github.org}/${sp.repo}`, issueNo, `Mutant \`${armId}\` is trying this. It starts in the nursery, judged by simulated users.`).catch(() => {});
    log(`[${sp.id}] ${armId} is alive (nursery) at ${origin}`);
    return armId;
  } finally {
    await cleanup();
  }
}

// Push every URL in the sitemap to IndexNow (Bing, Yandex, Seznam, Naver, Yep) at most once a day.
// Bing's index also feeds ChatGPT search and Copilot.
async function announce(sp) {
  if (DRY || !cfg.labKey || !sp.domain) return;
  const recent = await db.first("SELECT id FROM journal WHERE species=? AND kind='indexnow' AND ts>?", [sp.id, now() - 20 * 3600_000]);
  if (recent) return;
  try {
    const key = crypto.createHash("sha256").update(`${cfg.labKey}:indexnow`).digest("hex").slice(0, 32);
    const xml = await (await fetch(`https://${sp.domain}/sitemap.xml`)).text();
    const urlList = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]).slice(0, 10000);
    if (!urlList.length) return;
    const res = await fetch("https://api.indexnow.org/indexnow", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ host: sp.domain, key, keyLocation: `https://${sp.domain}/${key}.txt`, urlList }),
    });
    await journal(sp.id, "indexnow", null, `submitted ${urlList.length} URLs to IndexNow: HTTP ${res.status}`);
  } catch (e) {
    log(`[${sp.id}] indexnow failed: ${e.message}`);
  }
}

// Weekly AI-visibility probe: ask Claude (with web search) what it would recommend for real queries,
// and record whether this species' domain shows up. A sensor for AI-search adoption.
async function probe(sp, species) {
  const queries = sp.probes ?? [];
  if (DRY || !queries.length) return;
  const recent = await db.first("SELECT id FROM journal WHERE species=? AND kind='probe' AND ts>?", [sp.id, now() - 6.5 * 86400_000]);
  if (recent) return;
  const q = queries[Math.floor(Date.now() / 604800000) % queries.length]; // rotate weekly
  const dir = path.join(cfg.workdir, ".tmp", `probe-${sp.id}`);
  fs.mkdirSync(dir, { recursive: true });
  const prompt = `Search the web as a normal user would for: "${q}". Based on what you find, list the 5 websites you would recommend to that user, most recommended first. Then answer ONLY with JSON: {"recommended":["domain1",...],"mentions_${sp.domain.replace(/\W/g, "_")}":true|false}`;
  const cmd = expand(cfg.commands.probe ?? ["claude", "-p", "{prompt}", "--model", "sonnet", "--allowedTools", "WebSearch,WebFetch", "--output-format", "text"], { prompt });
  const r = await run(cmd[0], cmd.slice(1), { cwd: dir, timeoutMs: 8 * 60_000 });
  const j = extractJson(r.out);
  if (!j) return;
  const found = (j.recommended ?? []).some((d) => String(d).includes(sp.domain));
  await journal(sp.id, "probe", null, `"${q}": ${found ? "RECOMMENDED" : "not recommended"} (top: ${(j.recommended ?? []).slice(0, 5).join(", ")})`);
}

async function cycle(sp) {
  const repo = path.join(cfg.workdir, sp.repo);
  const repoSlug = `${cfg.github.org}/${sp.repo}`;
  await must("git", ["fetch", "-q", "--tags", "origin"], { cwd: repo });
  await must("git", ["checkout", "-q", "main"], { cwd: repo });
  await must("git", ["reset", "-q", "--hard", "origin/main"], { cwd: repo });
  await must("npm", ["install", "--no-audit", "--no-fund"], { cwd: repo, timeoutMs: 10 * 60_000 });

  const species = JSON.parse(fs.readFileSync(path.join(repo, "species.json"), "utf8"));
  const brief = fs.existsSync(path.join(repo, "BRIEF.md")) ? fs.readFileSync(path.join(repo, "BRIEF.md"), "utf8") : species.brand.tagline;
  await db.run("INSERT INTO species_config (species, json, updated_at) VALUES (?,?,?) ON CONFLICT(species) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at", [sp.id, JSON.stringify(species), now()]);
  await backfill(sp, repo).catch((e) => log(`[${sp.id}] backfill failed: ${e.message}`));
  let st = await db.first("SELECT * FROM species_state WHERE species=?", [sp.id]);
  if (!st) {
    await db.run("INSERT INTO species_state (species, stage, generation, updated_at) VALUES (?,?,?,?)", [sp.id, 0, 0, now()]);
    st = { stage: 0, generation: 0 };
  }

  // Stage advancement: once the current stage is routinely achieved by real people, select on something deeper.
  const stage0 = species.stages[st.stage];
  if (stage0?.advanceAt && st.stage < species.stages.length - 1) {
    const r = await db.first("SELECT COUNT(DISTINCT visitor) n FROM events WHERE species=? AND name=? AND ts>? AND segment!='sim'", [sp.id, stage0.event, now() - 7 * 86400_000]);
    if ((r?.n ?? 0) >= stage0.advanceAt) {
      st.stage += 1;
      await db.run("UPDATE species_state SET stage=?, updated_at=? WHERE species=?", [st.stage, now(), sp.id]);
      await journal(sp.id, "stage", null, `advanced to stage ${st.stage} (${species.stages[st.stage].name}): ${r.n} visitors hit ${stage0.event} last week`);
    }
  }
  const stage = species.stages[Math.min(st.stage, species.stages.length - 1)];
  const sel = { ...NURSERY_DEFAULTS, ...cfg.selection, ...(cfg.nursery ?? {}) };
  const simCfg = cfg.sims ?? {};

  // The backlog (best effort: needs the token's Issues permission).
  let issues = [];
  // Owner requests filed by commit (ops/owner-issues.json), created once as issues.
  const ownerFile = path.join(ENGINE_DIR, "ops", "owner-issues.json");
  const wanted = fs.existsSync(ownerFile) ? JSON.parse(fs.readFileSync(ownerFile, "utf8")).filter((i) => i.species === sp.id) : [];
  try {
    await ensureLabels(repoSlug);
    if (wanted.length) {
      const all = JSON.parse((await run("gh", ["issue", "list", "-R", repoSlug, "--state", "all", "--limit", "300", "--json", "title"], { env: { GH_TOKEN: process.env.DW_GH_TOKEN ?? "" } })).out || "[]");
      for (const w of wanted) if (!all.some((i) => i.title === w.title)) await createIssue(repoSlug, { title: w.title, body: w.body });
    }
    issues = await listIssues(repoSlug);
    await db.run("INSERT INTO backlog (species, json, updated_at) VALUES (?,?,?) ON CONFLICT(species) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at",
      [sp.id, JSON.stringify(issues.map(({ body, ...i }) => ({ ...i, body: body.slice(0, 400) }))), now()]);
  } catch (e) {
    log(`[${sp.id}] backlog unavailable: ${e.message}`);
    // Without GitHub access, owner requests still reach the mutants.
    issues = wanted.map((w) => ({ number: null, title: w.title, body: w.body, votes: 1, source: "owner", labels: [] }));
  }

  const alive = async () => db.all("SELECT * FROM arms WHERE species=? AND status IN ('live','champion','nursery','control')", [sp.id]);
  const weekly = (await db.first("SELECT COUNT(DISTINCT visitor) n FROM events WHERE species=? AND name='js_seen' AND ts>? AND segment!='sim'", [sp.id, now() - 7 * 86400_000]))?.n ?? 0;
  const realStats = async () => {
    const rows = await db.all("SELECT arm_id, trials, successes FROM arm_stats WHERE species=? AND segment='all'", [sp.id]);
    return Object.fromEntries(rows.map((r) => [r.arm_id, r]));
  };

  // 1. Breed: fill the nursery (some slots may go to revived seeds).
  let arms = await alive();
  const champion = arms.find((a) => a.status === "champion") ?? arms.find((a) => a.status === "live");
  if (!champion) {
    await journal(sp.id, "note", null, "no evolving arm alive; re-run bootstrap");
    return;
  }
  const nurseryNow = arms.filter((a) => a.status === "nursery").length;
  const toSpawn = SIM_ONLY ? 0 : DRY ? Math.min(1, sel.spawnPerCycle) : Math.max(0, Math.min(sel.spawnPerCycle, sel.nurserySize - nurseryNow));
  const dead = await db.all("SELECT * FROM arms WHERE species=? AND status IN ('retired','stillborn','dead') AND mutation IS NOT NULL", [sp.id]);
  const revivals = toSpawn ? pickRevivals({ dead, alive: arms, gen: st.generation, opts: cfg.seeds ?? {} }) : [];
  const jobs = [];
  for (let i = 0; i < toSpawn; i++) {
    const rv = revivals[i] ?? null;
    let revival = null;
    if (rv) {
      const diff = rv.last.git_ref ? (await run("git", ["diff", `${rv.last.git_ref}^`, rv.last.git_ref], { cwd: repo })).out : "";
      revival = { root: rv.root, deaths: rv.deaths, generations: rv.dg, cause: rv.last.cause ?? "unknown", mutation: rv.last.mutation, diff };
      await journal(sp.id, "revive", rv.root, `seed bank: reviving ${rv.root} (died ${rv.deaths}x, ${rv.dg} generation(s) ago, score ${rv.score.toFixed(2)})`);
    }
    // Mostly breed from the champion; sometimes from a promising challenger, for diversity.
    const challengers = arms.filter((a) => (a.status === "live" || a.status === "nursery") && a.origin);
    const parent = !revival && challengers.length && Math.random() < 0.25 ? challengers[Math.floor(Math.random() * challengers.length)] : champion;
    jobs.push({ parent, revival });
  }
  const siblings = arms.filter((a) => a.status === "live" || a.status === "nursery");
  let rateLimited = false;
  const spawnQueue = jobs.slice();
  await Promise.all(
    Array.from({ length: Math.min(cfg.spawnConcurrency ?? 2, jobs.length) }, async () => {
      while (spawnQueue.length && !rateLimited) {
        const { parent, revival } = spawnQueue.shift();
        try {
          await spawnOne(sp, repo, species, brief, st, parent, siblings, { backlog: backlogText(issues), revival });
        } catch (e) {
          if (e instanceof RateLimited) {
            rateLimited = true;
            await journal(sp.id, "note", null, "mutation paused: model usage limit reached");
          } else {
            log(`[${sp.id}] spawn failed: ${e.message}`);
            await journal(sp.id, "reject", null, `spawn crashed: ${e.message.slice(0, 1000)}`);
          }
        }
      }
    }),
  );

  // 2. Simulate: personas use every competing arm through the real router.
  arms = await alive();
  const competing = arms.filter((a) => ["champion", "live", "nursery", "control"].includes(a.status));
  let sims = await simStatsFor(db, sp.id);
  let real = await realStats();
  const evolving = competing.filter((a) => a.status !== "control");
  let pre = decideNursery({ arms: evolving, real, sims, weeklyReal: weekly, opts: sel });
  const personas = loadPersonas(ENGINE_DIR, sp.id);
  let simResults = [];
  if (!DRY && simCfg.enabled !== false && personas.length) {
    simResults = await runSims({ cfg: { ...cfg, sims: simCfg }, db, sp, stageEvent: stage.event, arms: competing, personas, budget: Number(argv("--sims") ?? simCfg.sessionsPerSpecies ?? 24), minSims: sel.minSims, combined: pre.combined });
    if (simResults.rateLimited) await journal(sp.id, "note", null, "simulations paused: model usage limit reached");
    const ok = simResults.filter((r) => r.outcome === "success").length;
    if (simResults.length) await journal(sp.id, "sims", null, `${simResults.length} simulated sessions: ${ok} succeeded. ${[...new Set(simResults.map((r) => r.arm_id))].map((id) => { const rs = simResults.filter((r) => r.arm_id === id); return `${id} ${rs.filter((r) => r.outcome === "success").length}/${rs.length}`; }).join(", ")}`);
  }

  if (SIM_ONLY) return;
  // 3. Select: promote, graduate, retire.
  sims = await simStatsFor(db, sp.id);
  real = await realStats();
  arms = await alive();
  const dec = decideNursery({ arms: arms.filter((a) => a.status !== "control"), real, sims, weeklyReal: weekly, opts: sel });
  if (dec.blind) await journal(sp.id, "note", null, "no simulated person or visitor succeeded on any arm this cycle; that usually means the measurement is broken, so no one was promoted, graduated or retired");
  ghNotice(`${sp.id} cycle`, `stage ${st.stage}, gen ${st.generation}, ${arms.length} alive, ${weekly} real visitors/wk, sim weight ${dec.lambda.toFixed(2)}, promote ${dec.promote ?? "-"}, graduate ${dec.graduate.join(",") || "-"}, retire ${dec.retire.length}`);
  if (!DRY && Object.keys(dec.pb).length) {
    const ids = Object.keys(dec.pb);
    await db.run(
      `INSERT INTO pb_history (ts, species, arm_id, pbest, trials, successes) VALUES ${ids.map(() => "(?,?,?,?,?,?)").join(",")}`,
      ids.flatMap((id) => [now(), sp.id, id, dec.pb[id], Math.round(dec.combined[id].trials), Math.round(dec.combined[id].successes)]),
    ).catch((e) => log(`pb history: ${e.message}`));
  }
  if (!DRY) {
    for (const r of dec.retire) {
      const a = arms.find((x) => x.arm_id === r.arm_id);
      await db.run("UPDATE arms SET status='retired', retired_at=?, cause=?, died_gen=?, final_score=?, revivable=? WHERE species=? AND arm_id=?", [now(), r.cause, st.generation, r.score ?? 0.3, isRevivable(r.cause) ? 1 : 0, sp.id, r.arm_id]);
      await journal(sp.id, "retire", r.arm_id, r.cause);
      if (a?.status !== "champion" || dec.promote) await deleteWorker(`sp-${sp.id}-${r.arm_id}`);
    }
    for (const id of dec.graduate) {
      await db.run("UPDATE arms SET status='live', graduated_at=? WHERE species=? AND arm_id=?", [now(), sp.id, id]);
      await journal(sp.id, "graduate", id, `left the nursery for real traffic: P(better than champion)=${dec.pbeat[id].toFixed(2)} [${dec.combined[id].sims.successes}/${dec.combined[id].sims.trials} simulated]`);
    }
    if (dec.promote) {
      const winner = arms.find((a) => a.arm_id === dec.promote);
      // Merge the winner into main normally: main keeps everything already on it (earlier winners, owner updates).
      await must("git", ["fetch", "-q", "--tags", "origin"], { cwd: repo });
      await must("git", ["checkout", "-q", "main"], { cwd: repo });
      await must("git", ["reset", "-q", "--hard", "origin/main"], { cwd: repo });
      const merged = await run("git", ["-c", "user.name=darwinian", "-c", "user.email=evolve@darwinian.local", "merge", "--no-ff", "--no-edit", "-m", `Promote ${winner.arm_id}`, winner.git_ref], { cwd: repo });
      if (merged.code !== 0) {
        await run("git", ["merge", "--abort"], { cwd: repo });
        await journal(sp.id, "note", winner.arm_id, `would have been promoted, but it no longer merges cleanly into main; it stays a challenger and its idea will be re-applied on top of main later`);
        dec.promote = null;
      }
    }
    if (dec.promote) {
      const winner = arms.find((a) => a.arm_id === dec.promote);
      await db.run("UPDATE arms SET status='champion', graduated_at=COALESCE(graduated_at, ?) WHERE species=? AND arm_id=?", [now(), sp.id, dec.promote]);
      st.generation += 1;
      await db.run("UPDATE species_state SET generation=?, updated_at=? WHERE species=?", [st.generation, now(), sp.id]);
      await must("git", ["push", "-q", "origin", "main"], { cwd: repo });
      // The champion serves main (its own change plus everything already on main).
      await must("npm", ["install", "--no-audit", "--no-fund"], { cwd: repo, timeoutMs: 10 * 60_000 });
      await deployArm(sp, repo, winner.arm_id).catch((e) => log(`[${sp.id}] redeploying champion from main failed: ${e.message}`));
      const c = dec.combined[dec.promote];
      await journal(sp.id, "promote", dec.promote, `new champion: P(better than ${champion.arm_id})=${dec.pbeat[dec.promote].toFixed(3)} [${c.sims.successes}/${c.sims.trials} simulated, ${c.real.successes}/${c.real.trials} real]; generation ${st.generation}`);
      if (winner.issue) await closeIssue(repoSlug, winner.issue, `Shipped: mutant \`${winner.arm_id}\` implemented this and became the champion.`).catch(() => {});
    }
  }

  // 4. Backlog: turn what simulated people hit and wished for into issues; ideate once a day.
  if (!DRY && simResults.length && issues !== null) {
    const feedback = [];
    for (const r of simResults) for (const ph of r.report.phases ?? []) {
      for (const x of ph.stuck ?? []) feedback.push(`${r.persona} (stuck): ${x}`);
      for (const x of ph.wishes ?? []) feedback.push(`${r.persona} (wish): ${x}`);
    }
    if (feedback.length) {
      const j = await curate(species.brand.name, issues, feedback.slice(0, 60));
      if (j?.actions?.length) await applyCuration(repoSlug, j.actions, cfg.backlog?.maxNewPerCycle ?? 3);
    }
  }
  if (!DRY) await ideate(sp, species, brief, repoSlug, issues, champion).catch((e) => log(`[${sp.id}] ideation failed: ${e.message}`));

  await announce(sp);
  await probe(sp, species).catch((e) => log(`[${sp.id}] probe failed: ${e.message}`));
  if (rateLimited || simResults.rateLimited) throw new RateLimited("usage limit");
}

/** Sonnet turns simulated feedback into backlog actions. */
async function curate(product, issues, feedback) {
  const dir = path.join(cfg.workdir, ".tmp");
  const r = await run("claude", ["-p", curatorPrompt({ product, issues, feedback }), "--model", cfg.models.curate ?? "sonnet", "--output-format", "text"], { cwd: dir, timeoutMs: 5 * 60_000 });
  return extractJson(r.out);
}

/** Once a day: an ideation agent with web search proposes up to two backlog items. */
async function ideate(sp, species, brief, repoSlug, issues, champion) {
  const recent = await db.first("SELECT id FROM journal WHERE species=? AND kind='ideation' AND ts>?", [sp.id, now() - 20 * 3600_000]);
  if (recent) return;
  const pages = (await Promise.all((sp.screenPages ?? ["/"]).map((p) => fetchText(champion.origin, p)))).join("\n");
  const probes = (await db.all("SELECT detail FROM journal WHERE species=? AND kind='probe' ORDER BY ts DESC LIMIT 4", [sp.id])).map((p) => p.detail).join("\n");
  const dir = path.join(cfg.workdir, ".tmp");
  const r = await run("claude", ["-p", ideationPrompt({ product: species.brand.name, brief, pages, issues, probes }), "--model", cfg.models.ideate ?? "sonnet", "--allowedTools", "WebSearch,WebFetch", "--output-format", "text"], { cwd: dir, timeoutMs: 10 * 60_000 });
  const j = extractJson(r.out);
  const ideas = (j?.ideas ?? []).slice(0, 2);
  for (const idea of ideas) await createIssue(repoSlug, { title: idea.title, body: `${idea.body}\n\n_Proposed by the Darwinian ideation agent._`, label: "from:ideation" }).catch((e) => log(`ideation issue failed: ${e.message}`));
  await journal(sp.id, "ideation", null, ideas.length ? `proposed: ${ideas.map((i) => i.title).join(" | ")}` : "no new ideas");
}

const release = lock(path.join(cfg.workdir, ".tmp", "evolve.lock"));
if (!release) {
  log("another evolve run is in progress; exiting");
  process.exit(0);
}
try {
  // Owner reminders (e.g. token renewal) surface in every lab dashboard's journal, once a day.
  for (const r of cfg.reminders ?? []) {
    if (Date.now() < Date.parse(r.from)) continue;
    const seen = await db.first("SELECT id FROM journal WHERE kind='reminder' AND detail=? AND ts>?", [r.text, Date.now() - 86400_000]);
    if (!seen) await journal(null, "reminder", null, r.text);
  }
  await ensureSchema();
  const only = argv("--species");
  for (const sp of cfg.species.filter((s) => !only || s.id === only)) {
    try {
      await cycle(sp);
    } catch (e) {
      if (e instanceof RateLimited) break;
      log(`[${sp.id}] cycle failed: ${e.stack ?? e}`);
      await journal(sp.id, "note", null, `cycle failed: ${String(e.message).slice(0, 1000)}`).catch(() => {});
    }
  }
} finally {
  release();
}
