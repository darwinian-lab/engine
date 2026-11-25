// The PR pipeline: one mutant = a hypothesis, built with the evolve-to-prs skill into a PR (or a stack),
// reviewed by independent agents with feedback commits, then deployed to the nursery. Selection later merges
// (promotion) or closes (death) the PRs. No human anywhere.
import fs from "node:fs";
import path from "node:path";
import { run, must, rid, log, extractJson } from "./lib/util.mjs";
import { claudeStream } from "./lib/stream.mjs";
import { gate } from "./lib/gates.mjs";
import { hypothesisPrompt, buildPrompt, prReviewPrompt, addressPrompt, auditPrompt, repairPrompt, lessonsPrompt } from "./lib/prompts.mjs";
import { mutationSize } from "./lib/select.mjs";
import { parseImplements, comment } from "./lib/issues.mjs";
import { openPR, commentPR, closePR } from "./lib/ghpr.mjs";

const DOC_DOMAINS = ["hono.dev", "developers.cloudflare.com", "clerk.com", "developer.mozilla.org", "web.dev", "playwright.dev"];
const GIT_ID = ["-c", "user.name=darwinian", "-c", "user.email=evolve@darwinian.local"];

export function makePipeline(d) {
  const { cfg, db, journal, ghNotice, DRY, codex, deployArm, deleteWorker, photograph, stillborn, numstat, gitLock, RateLimited, now, cfEnv } = d;
  const gh = (args, opts = {}) => run("gh", args, { timeoutMs: 120_000, ...opts });

  const LIMIT_RE = /hit your [\w -]*limit|usage limit|rate.?limit|limit reached|quota|credit balance/i;

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
    if (LIMIT_RE.test(r.out) || (r.code !== 0 && LIMIT_RE.test(text))) throw new RateLimited(text.slice(-500));
    return json ? extractJson(r.out) : r;
  }

  // Agents get a full shell (no secrets in their environment); pushing and network fetches stay blocked.
  const CODE_TOOLS = ["Read", "Edit", "Write", "Glob", "Grep", "Bash"];
  const READ_TOOLS = ["Read", "Glob", "Grep", "Bash"];

  const commitsOf = async (wt, base, head) => (await run("git", ["log", "--format=%h %s", `${base}..${head}`], { cwd: wt })).out.trim();


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
    const size = resume?.size ?? mutationSize();
    const wip = { dir: path.join(cfg.workdir, "wip", `${sp.id}-${armId}`), state: resume ?? { armId, species: sp.id, parentId: parent.arm_id, size, revival: ctx.revival ?? null, attempts: 0, created: now() } };
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
      const hyp = wip.state.hyp ?? await agent({ label: `${sp.id}/${armId} hypothesis`, cwd: wt, prompt: hypothesisPrompt({ ...ctx.promptCtx, size }), model: cfg.models.hypothesis ?? "opus", tools: READ_TOOLS, minutes: 15, json: true });
      if (!hyp?.work_item) {
        await journal(sp.id, "reject", armId, "hypothesis step produced no work item");
        return null;
      }
      const revivalNote = ctx.revival ? `\n\n## This is a revival\nAn earlier mutant tried this idea and died (${ctx.revival.cause}). Re-implement the same idea on the current code and avoid what killed it.\n\n${ctx.revival.mutation}` : "";
      const workItem = `# ${hyp.title}\n\n**Hypothesis:** ${hyp.hypothesis}\n${hyp.implements_issue ? `\n**Implements:** #${hyp.implements_issue}\n` : ""}\n## Work item\n${hyp.work_item}\n\n## Acceptance criteria\n${(hyp.acceptance_criteria ?? []).map((c) => `- ${c}`).join("\n")}${revivalNote}\n`;
      const workItemFile = path.join(runDir, "work-item.md");
      fs.writeFileSync(workItemFile, workItem);
      await checkpoint("build", { hyp });
      ghNotice(`${sp.id} ${armId} hypothesis`, `${hyp.title}: ${hyp.hypothesis}`);
      await journal(sp.id, "progress", armId, `hypothesis chosen: ${hyp.title}. ${hyp.hypothesis}${hyp.implements_issue ? ` (implements #${hyp.implements_issue})` : ""}; building it now`);

      // 2. Build with evolve-to-prs: one mutation, one branch, one PR.
      const branch = prefix;
      const resultFile = path.join(runDir, "result.json");
      if (!(resume && fs.existsSync(resultFile) && wip.state.stage !== "build")) {
        const buildArgs = { label: `${sp.id}/${armId} build`, cwd: wt, model: cfg.models.mutate ?? "sonnet", tools: [...CODE_TOOLS, "Task", "TodoWrite"], browser: true, web: true, minutes: cfg.timeouts?.buildMin ?? 150, onSession: (id) => checkpoint(null, { buildSession: id }) };
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
      if (!fs.existsSync(path.join(runDir, "phased-plan.md"))) ghNotice(`${sp.id} ${armId} build`, "the builder skipped the planner (no phased-plan.md in the run folder)");
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
      const rounds = cfg.prReviewRounds ?? 3;
      const history = [];
      let approved = false;
      let lastFindings = [];
      for (let round = 1; round <= rounds + 1; round++) {
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
      const issueNo = hyp.implements_issue ?? parseImplements(workItem);
      await db.run(
        `INSERT INTO arms (species, arm_id, origin, status, generation, parent, git_ref, hypothesis, created_at, mutation, size, diffstat, audit, personas, shot_at, revived_from, revivable, issue, prs, work_item)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [sp.id, armId, origin, "nursery", st.generation + 1, parent.arm_id, tag, `${hyp.title}: ${hyp.hypothesis}`.slice(0, 600), now(), mutationText, size, JSON.stringify(diffstat), JSON.stringify(auditInfo), null, now(), ctx.revival?.root ?? null, 1, issueNo, JSON.stringify(prs), JSON.stringify(hyp)],
      );
      await commentPR(repoSlug, topPr.number, `Approved by automated review and deployed to the nursery as \`${armId}\`. Simulated people judge it next; it is merged only if it wins selection.`);
      if (issueNo) await comment(repoSlug, issueNo, `Mutant \`${armId}\` is trying this: ${topPr.url}`).catch(() => {});
      await journal(sp.id, "spawn", armId, `${size} ${ctx.revival ? `revival of ${ctx.revival.root}, ` : ""}mutation of ${parent.arm_id} as ${prs.map((p) => `#${p.number}`).join(" + ")}: ${hyp.title}. ${hyp.hypothesis}`);
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
    const prs = JSON.parse(winner.prs);
    const head = prs.at(-1).head;
    await must("git", ["fetch", "-q", "--tags", "origin"], { cwd: repo });
    const fresh = (await run("git", ["merge-base", "--is-ancestor", "origin/main", winner.git_ref], { cwd: repo })).code === 0;
    if (fresh) {
      await must("git", ["checkout", "-q", "main"], { cwd: repo });
      await must("git", ["reset", "-q", "--hard", "origin/main"], { cwd: repo });
      const m = await run("git", [...GIT_ID, "merge", "--no-ff", "--no-edit", "-m", `Promote ${winner.arm_id}: ${prs.map((p) => `#${p.number}`).join(", ")}`, winner.git_ref], { cwd: repo });
      if (m.code !== 0) {
        await run("git", ["merge", "--abort"], { cwd: repo });
        return "failed";
      }
      await must("git", ["push", "-q", "origin", "main"], { cwd: repo });
      return "merged";
    }
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
      fs.symlinkSync(path.join(repo, "node_modules"), path.join(wt, "node_modules"));
      const g = await gate(wt, base, species, { requireMutationFile: false });
      if (!g.ok) return "failed";
      await gitLock(() => must("git", ["push", "-q", "-f", "origin", `${branch}:refs/heads/${branch}`], { cwd: wt }));
      const { url } = await openPR(repoSlug, { base: "main", head: branch, title: `${prs.at(-1).title} (rebased onto main)`, body: `Finalist: \`${winner.arm_id}\` won selection, but main moved since it was bred. This is the same change rebased onto main. It must confirm itself against the current champion before it is merged.\n\nOriginal: ${prs.map((p) => p.url).join(", ")}` });
      const headSha = (await must("git", ["rev-parse", "HEAD"], { cwd: wt })).trim();
      const tag = `fossil/${sp.id}/${finalist}`;
      await gitLock(async () => {
        await must("git", ["tag", "-f", tag, headSha], { cwd: wt });
        await must("git", ["push", "-q", "-f", "origin", tag], { cwd: wt });
      });
      const { origin } = await deployArm(sp, wt, finalist);
      await photograph(sp, finalist, origin);
      const fprs = [{ number: Number(url.split("/pull/")[1] ?? 0), url, branch, base: "main", head: headSha, title: `${prs.at(-1).title} (rebased)` }];
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

  /** Distil this cycle's failures into the species' LESSONS.md (committed to main). */
  async function updateLessons(sp, repo, species, items) {
    if (!items.length || DRY) return;
    await must("git", ["fetch", "-q", "origin"], { cwd: repo });
    await must("git", ["checkout", "-q", "main"], { cwd: repo });
    await must("git", ["reset", "-q", "--hard", "origin/main"], { cwd: repo });
    const file = path.join(repo, "LESSONS.md");
    const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "# LESSONS.md\n";
    const r = await run("claude", ["-p", lessonsPrompt({ product: species.brand.name, current, items }), "--model", cfg.models.curate ?? "sonnet", "--output-format", "text"], { cwd: repo, timeoutMs: 10 * 60_000, agent: true, echoPrefix: `[${sp.id} lessons]` });
    const next = r.out.replace(/^```(?:markdown)?\n|\n```\s*$/g, "").trim();
    if (r.code !== 0 || !next.startsWith("# LESSONS.md")) return;
    fs.writeFileSync(file, next + "\n");
    if (!(await run("git", ["status", "--porcelain", "LESSONS.md"], { cwd: repo })).out.trim()) return;
    await must("git", [...GIT_ID, "commit", "-q", "-m", "Update lessons from this cycle", "LESSONS.md"], { cwd: repo });
    await must("git", ["push", "-q", "origin", "main"], { cwd: repo });
  }

  return { spawnPR, closePRs, promotePR, updateLessons, agent, pendingWip };
}
