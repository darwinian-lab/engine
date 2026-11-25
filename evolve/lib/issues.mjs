// The backlog: each species' own (private) GitHub issues. Fed by the owner, by simulated people
// (problems they hit, things they wished for) and by an ideation agent. Mutations may pick an item.
// Labels: from:sim, from:ideation (unlabeled = owner, highest priority), mutant:<arm> when being tried.
import { run, log, extractJson } from "./util.mjs";

const env = () => ({ GH_TOKEN: process.env.DW_GH_TOKEN ?? process.env.GH_TOKEN ?? "" });
let warned = false;

async function gh(args, input) {
  const r = await run("gh", args, { env: env(), input, timeoutMs: 60_000 });
  if (r.code !== 0) {
    if (!warned && process.env.GITHUB_ACTIONS && /Resource not accessible|403|permission/i.test(r.err)) {
      warned = true;
      console.log("::warning title=backlog::The GitHub token can't use issues. Give DW_GH_TOKEN 'Issues: Read and write' on the species repos.");
    }
    throw new Error(`gh ${args.slice(0, 3).join(" ")}: ${r.err.slice(-300)}`);
  }
  return r.out;
}

const LABELS = [
  ["from:sim", "c5def5", "Reported by simulated users"],
  ["from:ideation", "d4c5f9", "Proposed by the ideation agent"],
];

export async function ensureLabels(repo) {
  for (const [name, color, desc] of LABELS) {
    await run("gh", ["label", "create", name, "-R", repo, "--color", color, "--description", desc], { env: env() });
  }
}

export async function listIssues(repo) {
  const out = await gh(["issue", "list", "-R", repo, "--state", "open", "--limit", "60", "--json", "number,title,body,labels,comments,reactionGroups,createdAt"]);
  return JSON.parse(out).map((i) => {
    const labels = (i.labels ?? []).map((l) => l.name);
    const thumbs = (i.reactionGroups ?? []).find((g) => g.content === "THUMBS_UP")?.users?.totalCount ?? 0;
    const votes = 1 + thumbs + (i.comments ?? []).filter((c) => /^\+1\b/.test(c.body ?? "")).length;
    const source = labels.includes("from:sim") ? "sim" : labels.includes("from:ideation") ? "ideation" : "owner";
    return { number: i.number, title: i.title, body: (i.body ?? "").slice(0, 800), labels, votes, source, createdAt: i.createdAt };
  });
}

/** Owner requests first, then by votes. */
export function rankIssues(issues) {
  const w = { owner: 3, sim: 1, ideation: 1 };
  return issues.slice().sort((a, b) => w[b.source] - w[a.source] || b.votes - a.votes || a.number - b.number);
}

export function backlogText(issues, n = 10) {
  return rankIssues(issues)
    .slice(0, n)
    .map((i) => `- ${i.number ? `#${i.number}` : "(not filed yet)"} (${i.source === "owner" ? "OWNER REQUEST" : `${i.source}, ${i.votes} vote${i.votes === 1 ? "" : "s"}`}) ${i.title}: ${i.body.replace(/\s+/g, " ").slice(0, 300)}`)
    .join("\n");
}

export async function createIssue(repo, { title, body, label }) {
  const out = await gh(["issue", "create", "-R", repo, "--title", title.slice(0, 120), "--body", body.slice(0, 6000), ...(label ? ["--label", label] : [])]);
  log(`backlog: created ${out.trim()}`);
  return out.trim();
}

export async function comment(repo, number, body) {
  await gh(["issue", "comment", String(number), "-R", repo, "--body", body.slice(0, 6000)]);
}

export async function closeIssue(repo, number, body) {
  await gh(["issue", "close", String(number), "-R", repo, "--comment", body.slice(0, 6000)]);
}

/** Apply curator actions (create / upvote) produced by an LLM from simulated feedback. */
export async function applyCuration(repo, actions, maxCreate = 3) {
  let created = 0;
  for (const a of actions ?? []) {
    try {
      if (a.op === "create" && created < maxCreate && a.title) {
        await createIssue(repo, { title: a.title, body: `${a.body ?? ""}\n\n_Filed by the Darwinian engine from simulated user sessions._`, label: "from:sim" });
        created++;
      } else if (a.op === "upvote" && a.number) {
        await comment(repo, a.number, `+1 from simulated users: ${a.note ?? ""}`);
      }
    } catch (e) {
      log(`backlog action failed: ${e.message}`);
    }
  }
}

export function parseImplements(mutationText) {
  const m = (mutationText ?? "").match(/\*\*Implements:\*\*\s*#(\d+)/i);
  return m ? Number(m[1]) : null;
}

export { extractJson };
