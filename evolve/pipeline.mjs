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

const DOC_DOMAINS = ["hono.dev", "developers.cloudflare.com", "clerk.com", "developer.mozilla.org", "web.dev", "playwright.dev"];
const GIT_ID = ["-c", "user.name=darwinian", "-c", "user.email=evolve@darwinian.local"];

export function makePipeline(d) {
  const { cfg, db, journal, ghNotice, DRY, codex, deployArm, deleteWorker, photograph, stillborn, numstat, gitLock, RateLimited, now, cfEnv } = d;
  const gh = (args, opts = {}) => run("gh", args, { timeoutMs: 120_000, ...opts });

  /** A Claude Code agent with no secrets in its environment. */
  async function agent({ cwd, prompt, model, tools, browser = false, web = false, minutes = 30, json = false, label = "agent" }) {
    fs.mkdirSync(path.join(cwd, ".dw"), { recursive: true });
    const promptFile = path.join(cwd, ".dw", `prompt-${rid(6)}.md`);
    fs.writeFileSync(promptFile, prompt);
    const args = ["-p", `Read the file ${promptFile} and carry out the instructions in it exactly. Work autonomously until done.`, "--model", model, "--permission-mode", "acceptEdits"];
    const allowed = [...tools];
    if (browser) {
      const mcp = path.join(cwd, ".dw", `mcp-${rid(6)}.json`);
      const profile = path.join(cfg.workdir, ".tmp", "agent-browser", rid(8));
      fs.writeFileSync(mcp, JSON.stringify({ mcpServers: { browser: { command: cfg.sims?.mcpCommand ?? "playwright-mcp", args: ["--headless", "--browser", cfg.sims?.browser ?? "chrome", "--user-data-dir", profile, "--output-dir", path.join(cwd, ".dw", "browser")] } } }));
      args.push("--mcp-config", mcp, "--strict-mcp-config");
      allowed.push("mcp__browser");
    }
    if (web) allowed.push(...DOC_DOMAINS.map((dom) => `WebFetch(domain:${dom})`));
    args.push("--allowedTools", allowed.join(","), "--disallowedTools", "Bash(git push:*),Bash(git remote:*),Bash(curl:*),Bash(wget:*)");
    // Each agent gets its own local dev-server port so parallel builders don't collide.
    const r = await claudeStream({ args, cwd, label, timeoutMs: minutes * 60_000, transcriptDir: path.join(cfg.workdir, ".tmp", "transcripts"), env: { DW_DEV_PORT: String(8800 + Math.floor(Math.random() * 900)) } });
    const text = r.out + r.err;
    if (r.code !== 0 && /rate.?limit|usage limit|limit reached|quota/i.test(text)) throw new RateLimited(text.slice(-500));
    return json ? extractJson(r.out) : r;
  }

  const CODE_TOOLS = ["Read", "Edit", "Write", "Glob", "Grep", "Bash(git:*)", "Bash(npm:*)", "Bash(npx:*)", "Bash(node:*)", "Bash(ls:*)", "Bash(cat:*)", "Bash(mkdir:*)", "Bash(rm:*)", "Bash(cp:*)", "Bash(mv:*)"];
  const READ_TOOLS = ["Read", "Glob", "Grep", "Bash(git log:*)", "Bash(git diff:*)", "Bash(git show:*)", "Bash(ls:*)", "Bash(cat:*)"];

  const commitsOf = async (wt, base, head) => (await run("git", ["log", "--format=%h %s", `${base}..${head}`], { cwd: wt })).out.trim();

  /** Breed one mutant through the PR pipeline. Returns the arm id or null. */
  async function spawnPR(sp, repo, species, brief, st, parent, siblings, ctx) {
    const repoSlug = `${cfg.github.org}/${sp.repo}`;
    const armId = `g${st.generation + 1}-${rid()}`;
    const prefix = `arm/${armId}`;
    const size = mutationSize();
    const wt = path.join(cfg.workdir, "wt", `${sp.id}-${armId}`);
    const runDir = path.join(cfg.workdir, ".tmp", "runs", `${sp.id}-${armId}`);
    fs.mkdirSync(runDir, { recursive: true });
    const parentIsChampion = parent.status === "champion";
    const parentPrs = parent.prs ? JSON.parse(parent.prs) : null;
    const baseRef = parentIsChampion ? "origin/main" : parent.git_ref || "origin/main";
    const baseBranch = parentIsChampion ? "main" : parentPrs?.at(-1)?.branch ?? `arm/${parent.arm_id}`;
    log(`[${sp.id}] PR pipeline: ${armId} from ${parent.arm_id} (${size})`);
    await gitLock(() => must("git", ["worktree", "add", "--detach", wt, baseRef], { cwd: repo }));
    try {
      for (const p of species.protected ?? []) await run("git", ["checkout", "origin/main", "--", p.replace(/\/$/, "")], { cwd: wt });
      if ((await run("git", ["status", "--porcelain"], { cwd: wt })).out.trim()) {
        await run("git", ["add", "-A"], { cwd: wt });
        await must("git", [...GIT_ID, "commit", "-q", "-m", "Sync protected files from main"], { cwd: wt });
      }
      const baseSha = (await must("git", ["rev-parse", "HEAD"], { cwd: wt })).trim();
      fs.symlinkSync(path.join(repo, "node_modules"), path.join(wt, "node_modules"));
      fs.appendFileSync(path.join(repo, ".git", "info", "exclude"), "\n.dw/\nnode_modules\n.wrangler/\n");

      // 1. Hypothesis: what to build and why.
      const hyp = await agent({ label: `${sp.id}/${armId} hypothesis`, cwd: wt, prompt: hypothesisPrompt({ ...ctx.promptCtx, size }), model: cfg.models.hypothesis ?? "opus", tools: READ_TOOLS, minutes: 15, json: true });
      if (!hyp?.work_item) {
        await journal(sp.id, "reject", armId, "hypothesis step produced no work item");
        return null;
      }
      const revivalNote = ctx.revival ? `\n\n## This is a revival\nAn earlier mutant tried this idea and died (${ctx.revival.cause}). Re-implement the same idea on the current code and avoid what killed it.\n\n${ctx.revival.mutation}` : "";
      const workItem = `# ${hyp.title}\n\n**Hypothesis:** ${hyp.hypothesis}\n${hyp.implements_issue ? `\n**Implements:** #${hyp.implements_issue}\n` : ""}\n## Work item\n${hyp.work_item}\n\n## Acceptance criteria\n${(hyp.acceptance_criteria ?? []).map((c) => `- ${c}`).join("\n")}${revivalNote}\n`;
      const workItemFile = path.join(runDir, "work-item.md");
      fs.writeFileSync(workItemFile, workItem);
      ghNotice(`${sp.id} ${armId} hypothesis`, `${hyp.title}: ${hyp.hypothesis}`);
      await journal(sp.id, "progress", armId, `hypothesis chosen: ${hyp.title}. ${hyp.hypothesis}${hyp.implements_issue ? ` (implements #${hyp.implements_issue})` : ""}; building it now`);

      // 2. Build with evolve-to-prs.
      await agent({ label: `${sp.id}/${armId} build`, cwd: wt, prompt: buildPrompt({ workItemFile, baseSha, prefix, runDir }), model: cfg.models.mutate ?? "opus", tools: [...CODE_TOOLS, "Task", "TodoWrite"], browser: true, web: true, minutes: cfg.timeouts?.buildMin ?? 150 });
      const result = JSON.parse(fs.existsSync(path.join(runDir, "result.json")) ? fs.readFileSync(path.join(runDir, "result.json"), "utf8") : '{"parts":[]}');
      const mutationText = `${workItem}\n## Built\n${result.summary ?? ""}`;
      if (!result.parts?.length) {
        await journal(sp.id, "reject", armId, `nothing was built: ${String(result.summary ?? "no result").slice(0, 600)}`);
        await stillborn(sp, armId, parent, st, `the builders produced no PR: ${String(result.summary ?? "no result").slice(0, 500)}`, { mutation: mutationText, size, revivedFrom: ctx.revival?.root });
        return null;
      }
      await journal(sp.id, "progress", armId, `built in ${result.phases ?? "?"} phase(s) as ${result.parts.length} PR part(s); running checks`);
      const top = result.parts.at(-1);
      await must("git", ["checkout", "-q", top.branch], { cwd: wt });

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

      // 4. Publish the PRs (the engine pushes; agents never hold credentials).
      const prs = [];
      for (let i = 0; i < result.parts.length; i++) {
        const part = result.parts[i];
        const head = (await must("git", ["rev-parse", part.branch], { cwd: wt })).trim();
        await gitLock(() => must("git", ["push", "-q", "-f", "origin", `${part.branch}:refs/heads/${part.branch}`], { cwd: wt }));
        const body = `${fs.existsSync(part.description_file ?? "") ? fs.readFileSync(part.description_file, "utf8") : result.summary ?? ""}\n\n---\n**Mutant** \`${armId}\` (${size}, parent \`${parent.arm_id}\`)${ctx.revival ? `, revival of \`${ctx.revival.root}\`` : ""}\n\n**Hypothesis:** ${hyp.hypothesis}${hyp.implements_issue ? `\n\nPart of #${hyp.implements_issue}` : ""}\n\n_Built and reviewed by the Darwinian engine; merged only if it wins selection._`;
        const bodyFile = path.join(runDir, `pr-body-${i + 1}.md`);
        fs.writeFileSync(bodyFile, body);
        const base = i === 0 ? baseBranch : result.parts[i - 1].branch;
        const r = await gh(["pr", "create", "-R", repoSlug, "--draft", "--base", base, "--head", part.branch, "--title", `${part.title ?? hyp.title}${result.parts.length > 1 ? ` (${i + 1}/${result.parts.length})` : ""}`, "--body-file", bodyFile]);
        const url = r.out.trim().split("\n").pop();
        if (!/\/pull\/\d+/.test(url)) throw new Error(`gh pr create failed: ${(r.err || r.out).slice(-400)}`);
        prs.push({ number: Number(url.split("/pull/")[1]), url, branch: part.branch, base, head, title: part.title ?? hyp.title });
      }
      const topPr = prs.at(-1);
      await journal(sp.id, "progress", armId, `opened ${prs.map((p) => p.url).join(", ")}; automated review starting`);
      const prBodies = prs.map((p, i) => `### PR ${i + 1}: ${p.title}\n${fs.readFileSync(path.join(runDir, `pr-body-${i + 1}.md`), "utf8")}`).join("\n\n");

      // 5. Automated PR review: Codex (charter) + a fresh Claude reviewer, feedback commits, up to N rounds.
      const rounds = cfg.prReviewRounds ?? 3;
      const history = [];
      let approved = false;
      let lastFindings = [];
      for (let round = 1; round <= rounds + 1; round++) {
        const headSha = (await must("git", ["rev-parse", "HEAD"], { cwd: wt })).trim();
        const diff = (await run("git", ["diff", `${baseSha}...${headSha}`], { cwd: wt })).out;
        const audit = await codex(auditPrompt({ charter: fs.readFileSync(path.join(wt, "CHARTER.md"), "utf8"), diff, mutation: workItem }), "audit");
        const review = await agent({ label: `${sp.id}/${armId} review r${round}`, cwd: wt, prompt: prReviewPrompt({ workItem, baseSha, headSha, prBodies, history: history.join("\n\n") }), model: cfg.models.review ?? "opus", tools: [...READ_TOOLS, "Bash(npm:*)", "Bash(npx:*)", "Bash(node:*)"], browser: true, minutes: 30, json: true });
        const findings = [
          ...((audit?.verdict === "pass" ? [] : audit?.violations ?? ["auditor unavailable"]).map((v, i) => ({ id: `A${round}.${i + 1}`, blocking: true, severity: "high", problem: v, fix: "", source: "charter audit" }))),
          ...((review?.findings ?? []).map((f, i) => ({ ...f, id: `R${round}.${i + 1}`, source: "code review" }))),
        ];
        if (!review) findings.push({ id: `R${round}.0`, blocking: true, severity: "high", problem: "the code reviewer returned no verdict", source: "code review" });
        const blocking = findings.filter((f) => f.blocking);
        lastFindings = blocking;
        const reviewBody = `### Automated review, round ${round}\n\n**Charter audit (Codex):** ${audit?.verdict === "pass" ? "pass" : "changes needed"}${audit?.summary ? `. ${audit.summary}` : ""}\n\n**Code review:** ${review?.verdict ?? "no verdict"}${review?.summary ? `. ${review.summary}` : ""}\n\n${findings.length ? findings.map((f) => `- **${f.id}** ${f.blocking ? "(blocking)" : "(non-blocking)"} ${f.file ? `\`${f.file}${f.line ? ":" + f.line : ""}\` ` : ""}${f.problem}${f.fix ? `\n  Fix: ${f.fix}` : ""}`).join("\n") : "No findings."}`;
        await gh(["pr", "comment", String(topPr.number), "-R", repoSlug, "--body", reviewBody.slice(0, 60000)]);
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
        await gh(["pr", "comment", String(topPr.number), "-R", repoSlug, "--body", dispText.slice(0, 60000)]);
        history.push(dispText);
      }
      const finalHead = (await must("git", ["rev-parse", "HEAD"], { cwd: wt })).trim();
      topPr.head = finalHead;
      const diffstat = numstat((await run("git", ["diff", "--numstat", baseSha, finalHead], { cwd: wt })).out);
      const auditInfo = { summary: `reviewed in ${history.filter((h) => h.startsWith("### Automated")).length} round(s)`, notes: [], rounds: [] };

      if (!approved || !g.ok) {
        const why = !g.ok ? `checks failing after review fixes: ${g.failure.slice(0, 400)}` : `automated review still found blocking problems after ${rounds} round(s): ${lastFindings.map((f) => f.problem).join("; ").slice(0, 700)}`;
        for (const p of prs) await gh(["pr", "close", String(p.number), "-R", repoSlug, "--comment", `Stillborn: ${why}\n\nThe idea is kept in the seed bank and may be revived on newer code.`]);
        await journal(sp.id, "reject", armId, why);
        await stillborn(sp, armId, parent, st, why, { mutation: mutationText, size, diffstat, revivedFrom: ctx.revival?.root });
        await db.run("UPDATE arms SET prs=?, work_item=? WHERE species=? AND arm_id=?", [JSON.stringify(prs), JSON.stringify(hyp), sp.id, armId]);
        return null;
      }

      // 6. Deploy the approved head to the nursery.
      for (const p of prs) await gh(["pr", "ready", String(p.number), "-R", repoSlug]);
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
      await gh(["pr", "comment", String(topPr.number), "-R", repoSlug, "--body", `Approved by automated review and deployed to the nursery as \`${armId}\`. Simulated people judge it next; it is merged only if it wins selection.`]);
      if (issueNo) await comment(repoSlug, issueNo, `Mutant \`${armId}\` is trying this: ${topPr.url}`).catch(() => {});
      await journal(sp.id, "spawn", armId, `${size} ${ctx.revival ? `revival of ${ctx.revival.root}, ` : ""}mutation of ${parent.arm_id} as ${prs.map((p) => `#${p.number}`).join(" + ")}: ${hyp.title}. ${hyp.hypothesis}`);
      return armId;
    } finally {
      await gitLock(() => run("git", ["worktree", "remove", "--force", wt], { cwd: repo }));
      await run("git", ["worktree", "prune"], { cwd: repo });
    }
  }

  /** Close a dead mutant's PRs with the evidence. */
  async function closePRs(sp, arm, reason) {
    if (!arm?.prs) return;
    for (const p of JSON.parse(arm.prs)) {
      await gh(["pr", "close", String(p.number), "-R", `${cfg.github.org}/${sp.repo}`, "--comment", `Retired by selection: ${reason}\n\nIts idea stays in the seed bank and may be revived later.`]);
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
      for (const p of prs) await gh(["pr", "edit", String(p.number), "-R", repoSlug, "--base", "main"]);
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
      const r = await gh(["pr", "create", "-R", repoSlug, "--base", "main", "--head", branch, "--title", `${prs.at(-1).title} (rebased onto main)`, "--body", `Finalist: \`${winner.arm_id}\` won selection, but main moved since it was bred. This is the same change rebased onto main. It must confirm itself against the current champion before it is merged.\n\nOriginal: ${prs.map((p) => p.url).join(", ")}`]);
      const url = r.out.trim().split("\n").pop();
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
      for (const p of prs) await gh(["pr", "close", String(p.number), "-R", repoSlug, "--comment", `Won selection, but main moved since it was bred. Continued as a finalist rebased onto main: ${url}`]);
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

  return { spawnPR, closePRs, promotePR, updateLessons, agent };
}
