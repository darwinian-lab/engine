// The PR pipeline: one mutant = a hypothesis, built with the evolve-to-prs skill into a PR (or a stack),
// reviewed by independent agents with feedback commits, then deployed to the nursery. Selection later merges
// (promotion) or closes (death) the PRs. No human anywhere.
import fs from "node:fs";
import path from "node:path";
import { run, must, rid, log, extractJson, limitHit } from "./lib/util.mjs";
import { claudeStream } from "./lib/stream.mjs";
import { gate } from "./lib/gates.mjs";
import { hypothesisPrompt, buildPrompt, prReviewPrompt, addressPrompt, auditPrompt, repairPrompt, lessonsPrompt } from "./lib/prompts.mjs";
import { mutationSize, SIZES } from "./lib/select.mjs";
import { parseImplements, comment } from "./lib/issues.mjs";
import { openPR, commentPR, closePR } from "./lib/ghpr.mjs";

const DOC_DOMAINS = ["hono.dev", "developers.cloudflare.com", "clerk.com", "developer.mozilla.org", "web.dev", "playwright.dev"];
const GIT_ID = ["-c", "user.name=darwinian", "-c", "user.email=evolve@darwinian.local"];

// Fallback directions for tournament variants when the hypothesis step doesn't give its own.
const DEFAULT_DIRECTIONS = {
  feature: [
    "MINIMAL: the smallest, calmest version that fully does the job. Few controls, smart defaults, zero clutter.",
    "RICH: the most capable version. Every option a demanding user expects from the best competitor, well organised.",
    "GUIDED: a step-by-step version that walks a first-time visitor through it, with previews and plain-language help.",
  ],
  redesign: [
    "Quiet and editorial: generous whitespace, a refined type pairing, restrained colour.",
    "Bold and confident: strong colour, big type, a memorable signature element.",
    "Warm and friendly: rounded shapes, soft palette, approachable illustrations or icons.",
  ],
};
const tournamentAsk = (n, size) => `

## This idea will be built as a tournament of ${n} variants
Choose an idea big enough that different executions could genuinely differ (size ${size}). Also add to your JSON a
field "variants": an array of exactly ${n} strings, each a clearly different DIRECTION for building the same idea
(different interaction model, depth or visual style; 1-3 sentences each, concrete enough to commit to). Separate
teams will build one each; simulated people compare them side by side and only the best survives.`;

export function makePipeline(d) {
  const { cfg, db, journal, ghNotice, DRY, codex, deployArm, deleteWorker, photograph, showcase, stillborn, numstat, gitLock, RateLimited, now, cfEnv } = d;
  const gh = (args, opts = {}) => run("gh", args, { timeoutMs: 120_000, ...opts });


  /** A Claude Code agent with no secrets in its environment. */
  async function agent({ cwd, prompt, model, tools, browser = false, web = false, minutes = 30, json = false, label = "agent", resume = null, onSession = null }) {
    fs.mkdirSync(path.join(cwd, ".dw"), { recursive: true });
    const promptFile = path.join(cwd, ".dw", `prompt-${rid(6)}.md`);
    fs.writeFileSync(promptFile, prompt);
    const args = ["-p", resume ? prompt : `Read the file ${promptFile} and carry out the instructions in it exactly. Work autonomously until done.`, "--model", model, "--permission-mode", "acceptEdits"];
    if (resume) args.push("--resume", resume);
    const allowed = [...tools];
    if (browser) {
      const mcp = path.join(cwd, ".dw", `mcp-${rid(6)}.json`);
      const profile = path.join(cfg.workdir, ".tmp", "agent-browser", rid(8));
      fs.writeFileSync(mcp, JSON.stringify({ mcpServers: { browser: { command: cfg.sims?.mcpCommand ?? "playwright-mcp", args: ["--headless", "--browser", cfg.sims?.browser ?? "chrome", "--user-data-dir", profile, "--output-dir", path.join(cwd, ".dw", "browser")] } } }));
      args.push("--mcp-config", mcp, "--strict-mcp-config");
      allowed.push("mcp__browser");
    }
    if (web) allowed.push(...DOC_DOMAINS.map((dom) => `WebFetch(domain:${dom})`));
    const denied = ["Bash(git push:*)", "Bash(git remote:*)", "Bash(curl:*)", "Bash(wget:*)"];
    args.push("--allowedTools", allowed.join(","), "--disallowedTools", denied.join(","));
    // Each agent gets its own local dev-server port so parallel builders don't collide.
    const r = await claudeStream({ args, cwd, label, onSession, timeoutMs: minutes * 60_000, transcriptDir: path.join(cfg.workdir, ".tmp", "transcripts"), env: { DW_DEV_PORT: String(8800 + Math.floor(Math.random() * 900)) } });
    const text = r.out + r.err;
    if (limitHit(r)) throw new RateLimited(text.slice(-500));
    return json ? extractJson(r.out) : r;
  }

  /**
   * Codex as a second builder. It edits the worktree (workspace-write sandbox, network for the local dev server and
   * docs, its own browser for checking the UI); the engine makes the commit. No secrets reach it (agentEnv).
   */
  async function codexBuild({ sp, armId, wt, branch, workItem, title, resultFile, size, resumed }) {
    if ((await run("git", ["rev-parse", "--verify", "-q", `refs/heads/${branch}`], { cwd: wt })).code !== 0) await must("git", ["checkout", "-q", "-b", branch], { cwd: wt });
    else await must("git", ["checkout", "-q", branch], { cwd: wt });
    fs.mkdirSync(path.join(wt, ".dw"), { recursive: true });
    const promptFile = path.join(wt, ".dw", "codex-build.md");
    fs.writeFileSync(promptFile, `# Build this mutation

You are building one mutant in a Darwinian software experiment. There is no human: work autonomously to the end.

1. Read CLAUDE.md, CHARTER.md, BRIEF.md and LESSONS.md in this repository first; they are the rules (CLAUDE.md
   applies to you too). Never modify protected files listed there or in CHARTER.md.
2. For anything visible, design first: read DESIGN.md and the design standard below, and look at how 2-3
   well-designed products handle the same interaction. Then implement the work item below completely: plan it in phases, build each phase, test it, and look at the result in
   your browser (start the dev server as CLAUDE.md describes) on desktop and mobile widths before moving on.
3. Add or update tests. Run npm test, npm run typecheck and npm run e2e, and fix everything until they pass.
4. Do not commit and do not touch git history; the engine commits your work. Do not push.
5. Last, write \`.dw/demo.json\` as described below and check its selectors in your browser against the running site.${resumed ? "\n6. An earlier attempt was interrupted: inspect `git status` / `git diff` and continue from the existing work." : ""}

Finish with a short plain summary of what you built (what a user will see, and anything left out).

${workItem}

${["design.md", "demo.md"].map((f) => fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "skills", "evolve-to-prs", "methods", f), "utf8")).join("\n\n")}`);
    const out = path.join(wt, ".dw", "codex-build-out.txt");
    const s = cfg.sims ?? {};
    const profile = path.join(cfg.workdir, ".tmp", "agent-browser", rid(8));
    const mcpArgs = "[" + ["--headless", "--browser", s.browser ?? "chrome", "--user-data-dir", profile, "--output-dir", path.join(wt, ".dw", "browser")].map((a) => JSON.stringify(a)).join(",") + "]";
    const b = cfg.builders ?? {};
    const args = ["exec", "--skip-git-repo-check", "-s", "workspace-write", "-c", 'approval_policy="never"', "-c", "sandbox_workspace_write.network_access=true",
      "-c", `model_reasoning_effort="${b.codexEffort ?? "high"}"`, ...(b.codexModel ? ["-m", b.codexModel] : []),
      "-c", 'mcp_servers.browser.default_tools_approval_mode="approve"', "-c", `mcp_servers.browser.command=${JSON.stringify(s.mcpCommand ?? "playwright-mcp")}`,
      "-c", `mcp_servers.browser.args=${mcpArgs}`, "-c", "mcp_servers.browser.startup_timeout_sec=60", "-c", "mcp_servers.browser.tool_timeout_sec=120",
      "-o", out, `Read ${promptFile} and carry out the instructions in it exactly.`];
    const minutes = Math.round((cfg.timeouts?.buildMin ?? 150) * (["feature", "redesign", "large"].includes(size) ? 1.6 : 1));
    const r = await run("codex", args, { cwd: wt, timeoutMs: minutes * 60_000, agent: true, env: { DW_DEV_PORT: String(8800 + Math.floor(Math.random() * 900)) }, echoPrefix: `[${sp.id}/${armId} codex build]` });
    const text = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : r.out;
    if (limitHit({ ...r, out: text })) throw new RateLimited(text.slice(-500));
    await run("git", ["add", "-A"], { cwd: wt });
    if ((await run("git", ["diff", "--cached", "--quiet"], { cwd: wt })).code !== 0) await must("git", [...GIT_ID, "commit", "-q", "-m", `${title}\n\nBuilt by Codex for mutant ${armId}.`], { cwd: wt });
    let demo = null;
    try { demo = JSON.parse(fs.readFileSync(path.join(wt, ".dw", "demo.json"), "utf8")); } catch {}
    fs.writeFileSync(resultFile, JSON.stringify({ branch, title, summary: text.trim().slice(0, 4000) || `Codex exited with code ${r.code}`, builder: "codex", demo }));
  }

  // Agents get a full shell (no secrets in their environment); pushing and network fetches stay blocked.
  const CODE_TOOLS = ["Read", "Edit", "Write", "Glob", "Grep", "Bash"];
  const READ_TOOLS = ["Read", "Glob", "Grep", "Bash"];

  const commitsOf = async (wt, base, head) => (await run("git", ["log", "--format=%h %s", `${base}..${head}`], { cwd: wt })).out.trim();


  /** A crossover's hypothesis is simply "both parents' improvements together". */
  function crossoverHypothesis(c) {
    const t = (x) => String(x.hypothesis ?? x.arm_id).split(":")[0].trim();
    return {
      title: `${t(c.a)} + ${t(c.b)}`,
      hypothesis: `${c.a.arm_id} and ${c.b.arm_id} each beat the champion on their own (P=${(c.a.pbeat ?? 0).toFixed(2)}, ${(c.b.pbeat ?? 0).toFixed(2)}). Together they should help more than either alone.`,
      work_item: `Combine the two mutants into one change on top of main, keeping both behaviours working together.\n\n- ${c.a.arm_id}: ${c.a.hypothesis}\n- ${c.b.arm_id}: ${c.b.hypothesis}`,
      acceptance_criteria: ["Everything each parent added still works", "The two changes don't contradict each other in copy or layout", "Core flows still pass"],
      implements_issue: null,
    };
  }

  const chosenThisCycle = new Map();
  let hypChain = Promise.resolve();
  const hypLock = (fn) => {
    const p = hypChain.then(fn, fn);
    hypChain = p.catch(() => {});
    return p;
  };

  const CLAUDE_PROJECTS = path.join(process.env.HOME ?? "", ".claude", "projects");

  /** Save a mutant's progress (branch, run folder, agent sessions) so the next cycle can pick it up. */
  async function saveWip(repo, wt, runDir, wip, branch) {
    fs.mkdirSync(wip.dir, { recursive: true });
    const hasBranch = (await run("git", ["rev-parse", "--verify", "-q", `refs/heads/${branch}`], { cwd: repo })).code === 0;
    if (hasBranch && fs.existsSync(wt)) {
      const onBranch = (await run("git", ["symbolic-ref", "-q", "--short", "HEAD"], { cwd: wt })).out.trim() === branch;
      if (onBranch && (await run("git", ["status", "--porcelain"], { cwd: wt })).out.trim()) {
        await run("git", ["add", "-A"], { cwd: wt });
        await run("git", [...GIT_ID, "commit", "-q", "--no-verify", "-m", "Work in progress (interrupted)"], { cwd: wt });
      }
    }
    const baseRef = `refs/dw/${wip.state.armId}/base`;
    if (wip.state.baseSha) await run("git", ["update-ref", baseRef, wip.state.baseSha], { cwd: repo });
    const refs = [wip.state.baseSha ? baseRef : null, hasBranch ? `refs/heads/${branch}` : null].filter(Boolean);
    if (refs.length) await must("git", ["bundle", "create", path.join(wip.dir, "repo.bundle"), ...refs], { cwd: repo });
    if (fs.existsSync(runDir)) {
      fs.rmSync(path.join(wip.dir, "run"), { recursive: true, force: true });
      fs.cpSync(runDir, path.join(wip.dir, "run"), { recursive: true, filter: (src) => !src.includes(`${path.sep}node_modules`) });
    }
    const id = wip.state.buildSession;
    if (id && fs.existsSync(CLAUDE_PROJECTS)) {
      for (const proj of fs.readdirSync(CLAUDE_PROJECTS)) {
        for (const name of [`${id}.jsonl`, id]) {
          const src = path.join(CLAUDE_PROJECTS, proj, name);
          if (fs.existsSync(src)) fs.cpSync(src, path.join(wip.dir, "claude", proj, name), { recursive: true });
        }
      }
    }
    fs.writeFileSync(path.join(wip.dir, "state.json"), JSON.stringify(wip.state, null, 2));
  }

  function restoreSessions(wipDir) {
    const saved = path.join(wipDir, "claude");
    if (fs.existsSync(saved)) fs.cpSync(saved, CLAUDE_PROJECTS, { recursive: true });
  }

  /** Mutants interrupted in earlier cycles, oldest first. */
  function pendingWip(spId) {
    const root = path.join(cfg.workdir, "wip");
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root)
      .filter((d) => d.startsWith(`${spId}-`) && fs.existsSync(path.join(root, d, "state.json")))
      .map((d) => JSON.parse(fs.readFileSync(path.join(root, d, "state.json"), "utf8")))
      .filter((w) => now() - (w.created ?? 0) < 3 * 86400_000)
      .sort((a, b) => (a.created ?? 0) - (b.created ?? 0));
  }

  /** Breed one mutant through the PR pipeline. Returns the arm id or null. */
  async function spawnPR(sp, repo, species, brief, st, parent, siblings, ctx, resume = null) {
    const repoSlug = `${cfg.github.org}/${sp.repo}`;
    const armId = resume?.armId ?? `g${st.generation + 1}-${rid()}`;
    const prefix = `arm/${armId}`;
    let size = resume?.size ?? ctx.tournament?.size ?? mutationSize(Math.random, cfg.sizeMix);
    // Tournament: several variants of one idea built in different directions (see run.mjs). Variant 0 chooses the
    // hypothesis; the others wait for it and build the same idea their own way.
    const tour = resume?.tournament ?? (ctx.tournament ? { id: ctx.tournament.id, idx: ctx.tournament.idx, n: ctx.tournament.n } : null);
    const wip = { dir: path.join(cfg.workdir, "wip", `${sp.id}-${armId}`), state: resume ?? { armId, species: sp.id, parentId: parent.arm_id, size, revival: ctx.revival ?? null, crossover: ctx.crossover ?? null, tournament: tour, attempts: 0, created: now() } };
    const cross = ctx.crossover ?? null;
    const wt = path.join(cfg.workdir, "wt", `${sp.id}-${armId}`);
    const runDir = path.join(cfg.workdir, ".tmp", "runs", `${sp.id}-${armId}`);
    fs.mkdirSync(runDir, { recursive: true });
    const parentIsChampion = parent.status === "champion";
    const parentPrs = parent.prs ? JSON.parse(parent.prs) : null;
    const baseRef = parentIsChampion ? "origin/main" : parent.git_ref || "origin/main";
    const baseBranch = parentIsChampion ? "main" : parentPrs?.at(-1)?.branch ?? `arm/${parent.arm_id}`;
    log(`[${sp.id}] PR pipeline: ${armId} from ${parent.arm_id} (${size})${resume ? `, resuming attempt ${resume.attempts + 1} at "${resume.stage}"` : ""}`);
    let keepWip = false;
    if (resume) {
      // Bring back the saved branch, run folder and agent session, then carry on where it stopped.
      await gitLock(async () => {
        await run("git", ["fetch", "-q", path.join(wip.dir, "repo.bundle"), "+refs/*:refs/*"], { cwd: repo });
        await must("git", ["worktree", "add", "--detach", wt, resume.baseSha], { cwd: repo });
      });
      if ((await run("git", ["rev-parse", "--verify", "-q", `refs/heads/${prefix}`], { cwd: repo })).code === 0) await run("git", ["checkout", "-q", prefix], { cwd: wt });
      if (fs.existsSync(path.join(wip.dir, "run"))) fs.cpSync(path.join(wip.dir, "run"), runDir, { recursive: true });
      restoreSessions(wip.dir);
    } else await gitLock(() => must("git", ["worktree", "add", "--detach", wt, baseRef], { cwd: repo }));
    try {
      if (!resume) {
        for (const p of species.protected ?? []) await run("git", ["checkout", "origin/main", "--", p.replace(/\/$/, "")], { cwd: wt });
        if ((await run("git", ["status", "--porcelain"], { cwd: wt })).out.trim()) {
          await run("git", ["add", "-A"], { cwd: wt });
          await must("git", [...GIT_ID, "commit", "-q", "-m", "Sync protected files from main"], { cwd: wt });
        }
      }
      const baseSha = resume?.baseSha ?? (await must("git", ["rev-parse", "HEAD"], { cwd: wt })).trim();
      Object.assign(wip.state, { baseSha, baseBranch, stage: wip.state.stage ?? "hypothesis" });
      fs.symlinkSync(path.join(repo, "node_modules"), path.join(wt, "node_modules"));
      fs.appendFileSync(path.join(repo, ".git", "info", "exclude"), "\n.dw/\nnode_modules\n.wrangler/\n");
      const checkpoint = async (stage, extra = {}) => {
        Object.assign(wip.state, extra, stage ? { stage } : {});
        await saveWip(repo, wt, runDir, wip, prefix);
      };

      // 1. Hypothesis: what to build and why.
      // Hypotheses are chosen one at a time per species so siblings bred in the same cycle pick different ideas.
      const choose = () => hypLock(async () => {
        const taken = (chosenThisCycle.get(sp.id) ?? []).map((h) => `- (this cycle) ${h}`).join("\n");
        const promptCtx = { ...ctx.promptCtx, size, siblings: [ctx.promptCtx?.siblings, taken].filter(Boolean).join("\n") };
        const h = await agent({ label: `${sp.id}/${armId} hypothesis`, cwd: wt, prompt: hypothesisPrompt(promptCtx) + (taken ? "\n\nOther mutants of this cycle already took the ideas marked (this cycle) above. Choose a clearly different problem, not a variation of theirs." : "") + (tour ? tournamentAsk(tour.n, size) : ""), model: cfg.models.hypothesis ?? "opus", tools: READ_TOOLS, minutes: 15, json: true });
        if (h?.title) chosenThisCycle.set(sp.id, [...(chosenThisCycle.get(sp.id) ?? []), `${h.title}: ${String(h.hypothesis ?? "").slice(0, 200)}`]);
        return h;
      });
      let hyp = wip.state.hyp ?? (cross ? crossoverHypothesis(cross) : null);
      if (!hyp && ctx.tournament) hyp = await (ctx.tournament.shared.hyp ??= choose());
      else if (!hyp) hyp = await choose();
      // An agreed backlog item knows its own size; otherwise the drawn size stands.
      if (!wip.state.hyp && !tour && hyp?.implements_issue && SIZES.includes(hyp.size)) size = wip.state.size = hyp.size;
      const direction = tour ? (hyp?.variants?.[tour.idx] ?? DEFAULT_DIRECTIONS[size === "redesign" ? "redesign" : "feature"][tour.idx % 3]) : null;
      if (!hyp?.work_item) {
        await journal(sp.id, "reject", armId, "hypothesis step produced no work item");
        return null;
      }
      const revivalNote = ctx.revival ? `\n\n## This is a revival\nAn earlier mutant tried this idea and died (${ctx.revival.cause}). Re-implement the same idea on the current code and avoid what killed it.\n\n${ctx.revival.mutation}` : "";
      const workItem = `# ${hyp.title}\n\n**Hypothesis:** ${hyp.hypothesis}\n${hyp.implements_issue ? `\n**Implements:** #${hyp.implements_issue}\n` : ""}\n## Work item\n${hyp.work_item}\n\n## Acceptance criteria\n${(hyp.acceptance_criteria ?? []).map((c) => `- ${c}`).join("\n")}${revivalNote}${direction ? `\n\n## Your variant's direction\nThis idea is being built ${tour.n} ways at once by separate teams; simulated people compare the versions side by side and only the best survives. Build it THIS way, fully committed to the direction, not a hedge between directions:\n\n${direction}` : ""}\n`;
      const workItemFile = path.join(runDir, "work-item.md");
      fs.writeFileSync(workItemFile, workItem);
      await checkpoint("build", { hyp });
      ghNotice(`${sp.id} ${armId} hypothesis`, `${hyp.title}: ${hyp.hypothesis}`);
      await journal(sp.id, "progress", armId, `hypothesis chosen: ${hyp.title}. ${hyp.hypothesis}${hyp.implements_issue ? ` (implements #${hyp.implements_issue})` : ""}; building it now`);

      // 2. Build with evolve-to-prs: one mutation, one branch, one PR.
      const branch = prefix;
      const resultFile = path.join(runDir, "result.json");
      let crossResolved = wip.state.crossResolved ?? false;
      if (cross && !(resume && fs.existsSync(resultFile))) {
        // Crossover: no new code from scratch. Merge both parents onto main; an agent only resolves conflicts.
        await must("git", ["fetch", "-q", "--tags", "origin"], { cwd: wt });
        if ((await run("git", ["rev-parse", "--verify", "-q", `refs/heads/${branch}`], { cwd: wt })).code !== 0) await must("git", ["checkout", "-q", "-b", branch], { cwd: wt });
        else await must("git", ["checkout", "-q", branch], { cwd: wt });
        let failed = null;
        for (const p of [cross.a, cross.b]) {
          if ((await run("git", ["merge-base", "--is-ancestor", p.git_ref, "HEAD"], { cwd: wt })).code === 0) continue;
          const m = await run("git", [...GIT_ID, "merge", "--no-ff", "--no-edit", "-m", `Cross in ${p.arm_id}: ${String(p.hypothesis ?? "").split(":")[0]}`, p.git_ref], { cwd: wt });
          if (m.code === 0) continue;
          crossResolved = true;
          await checkpoint(null, { crossResolved });
          await agent({ label: `${sp.id}/${armId} merge ${p.arm_id}`, cwd: wt, prompt: `Merging mutant ${p.arm_id} into this branch stopped with conflicts. This branch combines two mutants that each improved the product on their own:\n\n- ${cross.a.arm_id}: ${cross.a.hypothesis}\n- ${cross.b.arm_id}: ${cross.b.hypothesis}\n\nResolve every conflict so BOTH behaviours are kept and work together, then \`git add\` and \`git -c user.name=darwinian -c user.email=evolve@darwinian.local commit --no-edit\`. Run npm test, npm run typecheck and npm run e2e and fix anything broken with new commits. Never modify protected files.`, model: cfg.models.repair ?? "sonnet", tools: CODE_TOOLS, browser: true, minutes: 40 });
          if ((await run("git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"], { cwd: wt })).code === 0) {
            await run("git", ["merge", "--abort"], { cwd: wt });
            failed = `the two parents conflict and the conflicts could not be resolved while merging ${p.arm_id}`;
            break;
          }
        }
        if (failed) {
          await journal(sp.id, "reject", armId, `crossover failed: ${failed}`);
          await stillborn(sp, armId, parent, st, `crossover failed: ${failed}`, { mutation: workItem, size });
          await db.run("UPDATE arms SET crossed_from=? WHERE species=? AND arm_id=?", [`${cross.a.arm_id},${cross.b.arm_id}`, sp.id, armId]).catch(() => {});
          return null;
        }
        fs.writeFileSync(resultFile, JSON.stringify({ branch, title: hyp.title, summary: failed ?? `Combines ${cross.a.arm_id} and ${cross.b.arm_id}, which each beat the champion on their own.\n\n- ${cross.a.hypothesis}\n- ${cross.b.hypothesis}`, head: failed ? null : "merged" }));
        await checkpoint("checks");
      } else if (!(resume && fs.existsSync(resultFile) && wip.state.stage !== "build") && (wip.state.builder ??= process.env.DW_BUILDER || (Math.random() < (cfg.builders?.codexShare ?? 0) ? "codex" : "claude")) === "codex") {
        // Codex builds part of the mutants on its own quota; gates and review below are the same for both.
        await checkpoint(null, { builder: "codex" });
        await codexBuild({ sp, armId, wt, branch, workItem, title: hyp.title, resultFile, size, resumed: Boolean(resume) });
        await checkpoint("checks");
      } else if (!(resume && fs.existsSync(resultFile) && wip.state.stage !== "build")) {
        const buildArgs = { label: `${sp.id}/${armId} build`, cwd: wt, model: cfg.models.mutate ?? "sonnet", tools: [...CODE_TOOLS, "Task", "TodoWrite"], browser: true, web: true, minutes: Math.round((cfg.timeouts?.buildMin ?? 150) * (["feature", "redesign", "large"].includes(size) ? 1.6 : 1)), onSession: (id) => checkpoint(null, { buildSession: id }) };
        if (resume && wip.state.buildSession) {
          await agent({ ...buildArgs, resume: wip.state.buildSession, prompt: `You were interrupted (usage limit, outage or crash) and this session has been restored. Continue the work exactly where you left off: check git status, git log and the run folder ${runDir} (run-config.md, completion notes, reviews), finish the remaining phases, and write ${resultFile} last as the skill describes.` });
        } else {
          const note = resume ? `\n\nAn earlier attempt was interrupted. Its commits are on branch ${prefix} and its notes are in ${runDir}. Continue from them instead of starting over.` : "";
          await agent({ ...buildArgs, prompt: buildPrompt({ workItemFile, baseSha, branch: prefix, runDir }) + note });
        }
        await checkpoint("checks");
      }
      const result = fs.existsSync(resultFile) ? (() => { try { return JSON.parse(fs.readFileSync(resultFile, "utf8")); } catch { return {}; } })() : {};
      const mutationText = `${workItem}\n## Built\n${result.summary ?? ""}`;
      const built = (await run("git", ["rev-parse", "--verify", "-q", branch], { cwd: wt })).code === 0 && (await run("git", ["rev-list", "--count", `${baseSha}..${branch}`], { cwd: wt })).out.trim() !== "0";
      if (!built) {
        await journal(sp.id, "reject", armId, `nothing was built: ${String(result.summary ?? "no result").slice(0, 600)}`);
        await stillborn(sp, armId, parent, st, `the builder produced nothing: ${String(result.summary ?? "no result").slice(0, 500)}`, { mutation: mutationText, size, revivedFrom: ctx.revival?.root });
        return null;
      }
      await must("git", ["checkout", "-q", branch], { cwd: wt });
      if (!cross && wip.state.builder !== "codex" && !fs.existsSync(path.join(runDir, "phased-plan.md"))) ghNotice(`${sp.id} ${armId} build`, "the builder skipped the planner (no phased-plan.md in the run folder)");
      await journal(sp.id, "progress", armId, `built (${(await commitsOf(wt, baseSha, "HEAD")).split("\n").length} commits); running checks`);

      // 3. Viability gates on the top head (protected files, tests, typecheck, build, end-to-end).
      let g = await gate(wt, baseSha, species, { requireMutationFile: false });
      for (let i = 1; !g.ok && g.changes.length && i <= (cfg.repairRounds ?? 3); i++) {
        await agent({ label: `${sp.id}/${armId} repair`, cwd: wt, prompt: `${repairPrompt(g.failure)}\n\nAdd focused commits on top of the current branch; do not rewrite existing commits.`, model: cfg.models.repair ?? "sonnet", tools: CODE_TOOLS, browser: true, minutes: 30 });
        await run("git", ["add", "-A"], { cwd: wt });
        await run("git", [...GIT_ID, "commit", "-q", "-m", "Fix failing checks"], { cwd: wt });
        g = await gate(wt, baseSha, species, { requireMutationFile: false });
      }
      if (!g.ok) {
        await journal(sp.id, "reject", armId, `failed gates: ${g.failure.slice(0, 1500)}`);
        await stillborn(sp, armId, parent, st, `failed the build/test gates: ${g.failure.slice(0, 600)}`, { mutation: mutationText, size, revivedFrom: ctx.revival?.root });
        return null;
      }

      // 4. Publish the PR (the engine pushes; agents never hold credentials).
      await gitLock(() => must("git", ["push", "-q", "-f", "origin", `HEAD:refs/heads/${branch}`], { cwd: wt }));
      const prBody = `${result.summary ?? ""}\n\n---\n**Mutant** \`${armId}\` (${size}, parent \`${parent.arm_id}\`)${ctx.revival ? `, revival of \`${ctx.revival.root}\`` : ""}\n\n**Hypothesis:** ${hyp.hypothesis}${hyp.implements_issue ? `\n\nPart of #${hyp.implements_issue}` : ""}\n\n_Built and reviewed by the Darwinian engine; merged only if it wins selection._`;
      await checkpoint("pr");
      const opened = await openPR(repoSlug, { base: baseBranch, head: branch, title: result.title ?? hyp.title, body: prBody });
      const topPr = { ...opened, branch, base: baseBranch, head: (await must("git", ["rev-parse", "HEAD"], { cwd: wt })).trim(), title: result.title ?? hyp.title };
      const prs = [topPr];
      await journal(sp.id, "progress", armId, `opened ${topPr.url}; automated review starting`);
      await checkpoint("review", { pr: topPr });
      const prBodies = prBody;

      // 5. Automated PR review: Codex (charter) + a fresh Claude reviewer, feedback commits, up to N rounds.
      // Review effort follows the size of the change: small and medium get two rounds, big ones the full count.
      const rounds = Math.min(cfg.prReviewRounds ?? 3, { small: 2, medium: 2 }[size] ?? 3);
      const history = [];
      // A crossover that merged cleanly combines two already-reviewed changes: skip straight to the nursery.
      let approved = Boolean(cross && !crossResolved);
      let lastFindings = [];
      if (approved) await commentPR(repoSlug, topPr.number, "Crossover of two reviewed mutants that merged without conflicts; checks pass, so it goes straight to the nursery.");
      for (let round = 1; !approved && round <= rounds + 1; round++) {
        const headSha = (await must("git", ["rev-parse", "HEAD"], { cwd: wt })).trim();
        const diff = (await run("git", ["diff", `${baseSha}...${headSha}`], { cwd: wt })).out;
        const audit = await codex(auditPrompt({ charter: fs.readFileSync(path.join(wt, "CHARTER.md"), "utf8"), diff, mutation: workItem, earlier: history.join("\n\n") }), "audit");
        const review = await agent({ label: `${sp.id}/${armId} review r${round}`, cwd: wt, prompt: prReviewPrompt({ workItem, baseSha, headSha, prBodies, history: history.join("\n\n") }), model: cfg.models.review ?? "opus", tools: [...READ_TOOLS, "Bash(npm:*)", "Bash(npx:*)", "Bash(node:*)"], browser: true, minutes: 30, json: true });
        const findings = [
          ...((audit?.verdict === "pass" ? [] : audit?.violations ?? ["auditor unavailable"]).map((v, i) => ({ id: `A${round}.${i + 1}`, blocking: true, severity: "high", problem: v, fix: "", source: "charter audit" }))),
          ...((review?.findings ?? []).map((f, i) => ({ ...f, id: `R${round}.${i + 1}`, source: "code review" }))),
        ];
        if (!review) findings.push({ id: `R${round}.0`, blocking: true, severity: "high", problem: "the code reviewer returned no verdict", source: "code review" });
        const blocking = findings.filter((f) => f.blocking);
        lastFindings = blocking;
        const reviewBody = `### Automated review, round ${round}\n\n**Charter audit (Codex):** ${audit?.verdict === "pass" ? "pass" : "changes needed"}${audit?.summary ? `. ${audit.summary}` : ""}\n\n**Code review:** ${review?.verdict ?? "no verdict"}${review?.summary ? `. ${review.summary}` : ""}\n\n${findings.length ? findings.map((f) => `- **${f.id}** ${f.blocking ? "(blocking)" : "(non-blocking)"} ${f.file ? `\`${f.file}${f.line ? ":" + f.line : ""}\` ` : ""}${f.problem}${f.fix ? `\n  Fix: ${f.fix}` : ""}`).join("\n") : "No findings."}`;
        await commentPR(repoSlug, topPr.number, reviewBody);
        history.push(reviewBody);
        await journal(sp.id, "progress", armId, `review round ${round}: ${blocking.length ? `${blocking.length} blocking finding(s)` : "approved"}`);
        if (!blocking.length) {
          approved = true;
          break;
        }
        if (round > rounds) break;
        ghNotice(`${sp.id} ${armId} review round ${round}`, blocking.map((f) => f.problem).join(" | ").slice(0, 1500));
        const disp = await agent({ label: `${sp.id}/${armId} address r${round}`, cwd: wt, prompt: addressPrompt({ findings, round }), model: cfg.models.address ?? "opus", tools: CODE_TOOLS, browser: true, web: true, minutes: 45, json: true });
        await run("git", ["add", "-A"], { cwd: wt });
        await run("git", [...GIT_ID, "commit", "-q", "-m", `Address review round ${round}`], { cwd: wt });
        g = await gate(wt, baseSha, species, { requireMutationFile: false });
        for (let i = 1; !g.ok && i <= (cfg.repairRounds ?? 3); i++) {
          await agent({ label: `${sp.id}/${armId} repair`, cwd: wt, prompt: `${repairPrompt(g.failure)}\n\nAdd focused commits on top; do not rewrite existing commits.`, model: cfg.models.repair ?? "sonnet", tools: CODE_TOOLS, minutes: 30 });
          await run("git", ["add", "-A"], { cwd: wt });
          await run("git", [...GIT_ID, "commit", "-q", "-m", "Fix failing checks"], { cwd: wt });
          g = await gate(wt, baseSha, species, { requireMutationFile: false });
        }
        await gitLock(() => must("git", ["push", "-q", "-f", "origin", `HEAD:refs/heads/${topPr.branch}`], { cwd: wt }));
        const dispText = `### Author's response to round ${round}\n\n${(disp?.dispositions ?? []).map((x) => `- **${x.id}** ${x.action === "apply" ? `applied${x.commit ? ` in ${x.commit}` : ""}` : `rejected: ${x.reason}`}`).join("\n") || "No dispositions recorded."}${disp?.summary ? `\n\n${disp.summary}` : ""}${g.ok ? "" : `\n\nChecks still failing:\n\`\`\`\n${g.failure.slice(0, 1500)}\n\`\`\``}`;
        await commentPR(repoSlug, topPr.number, dispText);
        history.push(dispText);
      }
      const finalHead = (await must("git", ["rev-parse", "HEAD"], { cwd: wt })).trim();
      topPr.head = finalHead;
      const diffstat = numstat((await run("git", ["diff", "--numstat", baseSha, finalHead], { cwd: wt })).out);
      const auditInfo = { summary: `reviewed in ${history.filter((h) => h.startsWith("### Automated")).length} round(s)`, notes: [], rounds: [] };

      if (!approved || !g.ok) {
        const why = !g.ok ? `checks failing after review fixes: ${g.failure.slice(0, 400)}` : `automated review still found blocking problems after ${rounds} round(s): ${lastFindings.map((f) => f.problem).join("; ").slice(0, 700)}`;
        for (const p of prs) await closePR(repoSlug, p.number, `Stillborn: ${why}\n\nThe idea is kept in the seed bank and may be revived on newer code.`).catch((e) => log(`close PR: ${e.message}`));
        await journal(sp.id, "reject", armId, why);
        await stillborn(sp, armId, parent, st, why, { mutation: mutationText, size, diffstat, revivedFrom: ctx.revival?.root });
        await db.run("UPDATE arms SET prs=?, work_item=? WHERE species=? AND arm_id=?", [JSON.stringify(prs), JSON.stringify(hyp), sp.id, armId]);
        return null;
      }

      // 6. Deploy the approved head to the nursery.
      const tag = `fossil/${sp.id}/${armId}`;
      await gitLock(async () => {
        await must("git", ["tag", "-f", tag, finalHead], { cwd: wt });
        await must("git", ["push", "-q", "-f", "origin", tag], { cwd: wt });
      });
      if (DRY) return null;
      if (g.changes.some((c) => c.status === "A" && c.path.startsWith("migrations/"))) {
        await must("npx", ["wrangler", "d1", "migrations", "apply", `sp-${sp.id}`, "--remote"], { cwd: wt, env: cfEnv, timeoutMs: 5 * 60_000 });
      }
      const { origin } = await deployArm(sp, wt, armId);
      for (let i = 0; i < 18; i++) {
        const r = await fetch(origin + "/", { headers: { "x-dw-key": cfg.routerKey } }).catch(() => null);
        if (r && r.status !== 404 && r.status < 500) break;
        await new Promise((res) => setTimeout(res, 5000));
      }
      await photograph(sp, armId, origin);
      // Before/after shots and the flow video, also posted on the PR.
      const demoDiff = (await run("git", ["diff", baseSha, "HEAD", "--", ".", ":!package-lock.json"], { cwd: wt })).out;
      await showcase?.(sp, armId, origin, parent, { demo: result.demo ?? null, workItem, diff: demoDiff, pr: topPr });
      const issueNo = hyp.implements_issue ?? parseImplements(workItem);
      await db.run(
        // Upsert: a resumed mutant may already have a row from an earlier, interrupted attempt.
        `INSERT INTO arms (species, arm_id, origin, status, generation, parent, git_ref, hypothesis, created_at, mutation, size, diffstat, audit, personas, shot_at, revived_from, revivable, issue, prs, work_item, crossed_from, tournament, variant)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT (species, arm_id) DO UPDATE SET origin=excluded.origin, status=excluded.status, generation=excluded.generation, parent=excluded.parent, git_ref=excluded.git_ref, hypothesis=excluded.hypothesis, mutation=excluded.mutation, size=excluded.size, diffstat=excluded.diffstat, audit=excluded.audit, personas=excluded.personas, shot_at=excluded.shot_at, revived_from=excluded.revived_from, revivable=excluded.revivable, issue=excluded.issue, prs=excluded.prs, work_item=excluded.work_item, crossed_from=excluded.crossed_from, tournament=excluded.tournament, variant=excluded.variant, retired_at=NULL, cause=NULL`,
        [sp.id, armId, origin, "nursery", st.generation + 1, parent.arm_id, tag, `${hyp.title}: ${hyp.hypothesis}`.slice(0, 600), now(), mutationText, size, JSON.stringify(diffstat), JSON.stringify(auditInfo), null, now(), ctx.revival?.root ?? null, 1, issueNo, JSON.stringify(prs), JSON.stringify(hyp), cross ? `${cross.a.arm_id},${cross.b.arm_id}` : null, tour?.id ?? null, direction ? direction.slice(0, 300) : null],
      );
      await commentPR(repoSlug, topPr.number, `Approved by automated review and deployed to the nursery as \`${armId}\`. Simulated people judge it next; it is merged only if it wins selection.`);
      if (issueNo) await comment(repoSlug, issueNo, `Mutant \`${armId}\` is trying this: ${topPr.url}`).catch(() => {});
      await journal(sp.id, "spawn", armId, `${cross ? `crossover of ${cross.a.arm_id} × ${cross.b.arm_id}, ` : ""}${size} ${ctx.revival ? `revival of ${ctx.revival.root}, ` : ""}mutation of ${parent.arm_id}${tour ? ` (tournament ${tour.id}, variant ${tour.idx + 1}/${tour.n}: ${String(direction).slice(0, 80)})` : ""} as ${prs.map((p) => `#${p.number}`).join(" + ")}: ${hyp.title}. ${hyp.hypothesis}`);
      return armId;
    } catch (e) {
      // Keep the progress for the next cycle (usage limit, GitHub outage, crash), unless it keeps failing.
      if (wip.state.hyp && !DRY) {
        wip.state.attempts++;
        wip.state.lastError = String(e.message ?? e).slice(0, 500);
        if (wip.state.attempts < (cfg.wipMaxAttempts ?? 3)) {
          keepWip = await saveWip(repo, wt, runDir, wip, prefix).then(() => true, (err) => (log(`save progress: ${err.message}`), false));
          await journal(sp.id, "progress", armId, `interrupted at "${wip.state.stage}" (${wip.state.lastError.slice(0, 200)}); progress saved, resumes next cycle`).catch(() => {});
        }
      }
      throw e;
    } finally {
      if (!keepWip) fs.rmSync(wip.dir, { recursive: true, force: true });
      await gitLock(() => run("git", ["worktree", "remove", "--force", wt], { cwd: repo }));
      await run("git", ["worktree", "prune"], { cwd: repo });
    }
  }

  /** Close a dead mutant's PRs with the evidence. */
  async function closePRs(sp, arm, reason) {
    if (!arm?.prs) return;
    for (const p of JSON.parse(arm.prs)) {
      await closePR(`${cfg.github.org}/${sp.repo}`, p.number, `Retired by selection: ${reason}\n\nIts idea stays in the seed bank and may be revived later.`).catch((e) => log(`close PR: ${e.message}`));
    }
  }

  /**
   * Promote a PR mutant. If main has not moved since it was bred, merge its PRs. If main moved, rebase it onto
   * main as a finalist that must confirm itself in the nursery first. Returns "merged" | "finalist" | "failed".
   */
  async function promotePR(sp, repo, species, st, winner) {
    const repoSlug = `${cfg.github.org}/${sp.repo}`;
    const prs = winner.prs ? JSON.parse(winner.prs) : []; // legacy (pre-PR) arms have none
    const title = prs.at(-1)?.title ?? String(winner.hypothesis ?? winner.arm_id).split(":")[0].slice(0, 100);
    await must("git", ["fetch", "-q", "--tags", "origin"], { cwd: repo });
    // Fresh = main hasn't changed the product since this mutant was bred. Engine-owned files (LESSONS.md, the e2e
    // harness, capabilities...) change on main every cycle; those alone must not force a finalist round, or a winner
    // is rebased forever (seen: g1-fhb4 → r → rr → rrr).
    const sinceBase = (await must("git", ["diff", "--name-only", `${winner.git_ref}...origin/main`], { cwd: repo })).split("\n").filter(Boolean);
    const isProtected = (f) => (species.protected ?? []).some((p) => (p.endsWith("/") ? f.startsWith(p) : f === p));
    // Merge straight onto the current main (which may already hold other winners merged this cycle). Only real
    // conflicts, or checks that fail on the merged result, send it the slower finalist way.
    await must("git", ["checkout", "-q", "main"], { cwd: repo });
    await must("git", ["reset", "-q", "--hard", "origin/main"], { cwd: repo });
    const m = await run("git", [...GIT_ID, "merge", "--no-ff", "--no-edit", "-m", `Promote ${winner.arm_id}${prs.length ? `: ${prs.map((p) => `#${p.number}`).join(", ")}` : ""}`, winner.git_ref], { cwd: repo });
    if (m.code !== 0) {
      // Conflicts only in engine-owned files: main's version wins. Anything else: replay as a finalist.
      const conflicted = (await run("git", ["diff", "--name-only", "--diff-filter=U"], { cwd: repo })).out.split("\n").filter(Boolean);
      if (!(conflicted.length && conflicted.every(isProtected))) {
        await run("git", ["merge", "--abort"], { cwd: repo });
        return promoteAsFinalist();
      }
      await must("git", ["checkout", "--ours", "--", ...conflicted], { cwd: repo });
      await must("git", ["add", "--", ...conflicted], { cwd: repo });
      await must("git", [...GIT_ID, "commit", "-q", "--no-edit"], { cwd: repo });
    }
    if (sinceBase.some((f) => !isProtected(f))) {
      // Main changed the product since this mutant was bred: make sure the combination still passes.
      await run("npm", ["install", "--no-audit", "--no-fund"], { cwd: repo, timeoutMs: 10 * 60_000 });
      const g = await gate(repo, "origin/main", species, { requireMutationFile: false });
      if (!g.ok) {
        log(`[${sp.id}] ${winner.arm_id} merges cleanly but fails checks on top of main; replaying as a finalist`);
        await must("git", ["reset", "-q", "--hard", "origin/main"], { cwd: repo });
        return promoteAsFinalist();
      }
    }
    await must("git", ["push", "-q", "origin", "main"], { cwd: repo });
    const sha = (await must("git", ["rev-parse", "HEAD"], { cwd: repo })).trim();
    await db.run("UPDATE arms SET merge_sha=?, merged_at=? WHERE species=? AND arm_id=?", [sha, now(), sp.id, winner.arm_id]).catch(() => {});
    return "merged";

    async function promoteAsFinalist() {
    // Stale: rebase onto main and send the combination back to the nursery as a finalist.
    const finalist = `${winner.arm_id}r`;
    const wt = path.join(cfg.workdir, "wt", `${sp.id}-${finalist}`);
    const branch = `arm/${finalist}`;
    const base = (await must("git", ["rev-parse", "origin/main"], { cwd: repo })).trim();
    await gitLock(() => must("git", ["worktree", "add", "-B", branch, wt, winner.git_ref], { cwd: repo }));
    try {
      const parentBase = (await must("git", ["merge-base", winner.git_ref, "origin/main"], { cwd: repo })).trim();
      let rb = await run("git", [...GIT_ID, "rebase", "--onto", "origin/main", parentBase, branch], { cwd: wt });
      if (rb.code !== 0) {
        await agent({ label: `${sp.id}/${finalist} resolve conflicts`, cwd: wt, prompt: `A rebase of this branch onto main stopped with conflicts. Resolve every conflict so that BOTH main's behaviour and this branch's change are preserved, run \`git add\` and \`git -c user.name=darwinian -c user.email=evolve@darwinian.local rebase --continue\` until the rebase completes, then run npm test, npm run typecheck and npm run e2e and fix anything broken with focused commits. Never modify protected files.`, model: cfg.models.repair ?? "sonnet", tools: CODE_TOOLS, minutes: 40 });
        if ((await run("git", ["status"], { cwd: wt })).out.includes("rebase in progress")) {
          await run("git", ["rebase", "--abort"], { cwd: wt });
          return "failed";
        }
      }
      if (!fs.existsSync(path.join(wt, "node_modules"))) fs.symlinkSync(path.join(repo, "node_modules"), path.join(wt, "node_modules"));
      let g = await gate(wt, base, species, { requireMutationFile: false });
      for (let i = 0; !g.ok && i < 2; i++) {
        await agent({ label: `${sp.id}/${finalist} repair ${i + 1}`, cwd: wt, prompt: `This branch is a winning change replayed onto the latest main. Its checks now fail:\n\n${String(g.failure ?? "").slice(0, 6000)}\n\nFix it with new commits so both main's behaviour and this branch's change work. Run npm test, npm run typecheck and npm run e2e. Never modify protected files.`, model: cfg.models.repair ?? "sonnet", tools: CODE_TOOLS, browser: true, minutes: 40 });
        g = await gate(wt, base, species, { requireMutationFile: false });
      }
      if (!g.ok) return "failed";
      await gitLock(() => must("git", ["push", "-q", "-f", "origin", `${branch}:refs/heads/${branch}`], { cwd: wt }));
      const { url } = await openPR(repoSlug, { base: "main", head: branch, title: `${title} (rebased onto main)`, body: `Finalist: \`${winner.arm_id}\` won selection, but main moved since it was bred. This is the same change rebased onto main. It must confirm itself against the current champion before it is merged.${prs.length ? `\n\nOriginal: ${prs.map((p) => p.url).join(", ")}` : ""}` });
      const headSha = (await must("git", ["rev-parse", "HEAD"], { cwd: wt })).trim();
      const tag = `fossil/${sp.id}/${finalist}`;
      await gitLock(async () => {
        await must("git", ["tag", "-f", tag, headSha], { cwd: wt });
        await must("git", ["push", "-q", "-f", "origin", tag], { cwd: wt });
      });
      const { origin } = await deployArm(sp, wt, finalist);
      await photograph(sp, finalist, origin);
      const fprs = [{ number: Number(url.split("/pull/")[1] ?? 0), url, branch, base: "main", head: headSha, title: `${title} (rebased)` }];
      await db.run(
        `INSERT INTO arms (species, arm_id, origin, status, generation, parent, git_ref, hypothesis, created_at, mutation, size, diffstat, revivable, issue, prs, work_item, finalist_of, shot_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [sp.id, finalist, origin, "nursery", st.generation + 1, winner.arm_id, tag, winner.hypothesis, now(), winner.mutation, winner.size, JSON.stringify(numstat((await run("git", ["diff", "--numstat", base, headSha], { cwd: wt })).out)), 1, winner.issue, JSON.stringify(fprs), winner.work_item, winner.arm_id, now()],
      );
      for (const p of prs) await closePR(repoSlug, p.number, `Won selection, but main moved since it was bred. Continued as a finalist rebased onto main: ${url}`).catch((e) => log(`close PR: ${e.message}`));
      return "finalist";
    } finally {
      await gitLock(() => run("git", ["worktree", "remove", "--force", wt], { cwd: repo }));
    }
    }
  }

  /** Undo merges on main (newest first) for a rollback. Returns false if any revert conflicts. */
  async function revertMerges(sp, repo, shas) {
    if (!shas.length) return false;
    await must("git", ["fetch", "-q", "origin"], { cwd: repo });
    await must("git", ["checkout", "-q", "main"], { cwd: repo });
    await must("git", ["reset", "-q", "--hard", "origin/main"], { cwd: repo });
    for (const sha of shas) {
      const r = await run("git", [...GIT_ID, "revert", "--no-edit", "-m", "1", sha], { cwd: repo });
      if (r.code !== 0) {
        await run("git", ["revert", "--abort"], { cwd: repo });
        await must("git", ["reset", "-q", "--hard", "origin/main"], { cwd: repo });
        return false;
      }
    }
    await must("git", ["push", "-q", "origin", "main"], { cwd: repo });
    return true;
  }

  /** Distil this cycle's failures into the species' LESSONS.md (committed to main). */
  async function updateLessons(sp, repo, species, items) {
    if (!items.length || DRY) return;
    await must("git", ["fetch", "-q", "origin"], { cwd: repo });
    await must("git", ["checkout", "-q", "main"], { cwd: repo });
    await must("git", ["reset", "-q", "--hard", "origin/main"], { cwd: repo });
    const file = path.join(repo, "LESSONS.md");
    const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "# LESSONS.md\n";
    const text = await d.codexText(lessonsPrompt({ product: species.brand.name, current, items }), `${sp.id}-lessons`).catch(() => "");
    const next = text.replace(/^```(?:markdown)?\n|\n```\s*$/g, "").trim();
    if (!next.startsWith("# LESSONS.md")) return;
    fs.writeFileSync(file, next + "\n");
    if (!(await run("git", ["status", "--porcelain", "LESSONS.md"], { cwd: repo })).out.trim()) return;
    await must("git", [...GIT_ID, "commit", "-q", "-m", "Update lessons from this cycle", "LESSONS.md"], { cwd: repo });
    await must("git", ["push", "-q", "origin", "main"], { cwd: repo });
  }

  return { spawnPR, closePRs, promotePR, revertMerges, updateLessons, agent, pendingWip };
}
