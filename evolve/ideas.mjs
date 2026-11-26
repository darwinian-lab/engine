#!/usr/bin/env node
// Ideation loop: a research agent goes out on the web (competitors, what people search and ask for, what they hate
// about the alternatives, adjacent needs, wild bets) and files ideas into each species' backlog as `from:ideation`.
// Most will be mediocre; that's fine. They compete as mutants with normal priority (below ideas agreed with the
// owner) and selection decides which survive.
//
// Each run takes the next research angle per species (rotating), so the whole space gets covered over a few days.
// The open ideation backlog is capped: the oldest untouched ideas are closed to make room.
//
//   node evolve/ideas.mjs [--species qr] [--per-run 4] [--angle competitors] [--dry-run]
import fs from "node:fs";
import path from "node:path";
import { d1 } from "./lib/d1.mjs";
import { loadConfig } from "./lib/config.mjs";
import { run, log, extractJson, limitHit } from "./lib/util.mjs";
import { claudeStream } from "./lib/stream.mjs";
import { ensureLabels, createIssue, closeIssue } from "./lib/issues.mjs";

const args = process.argv.slice(2);
const argv = (k) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const cfg = loadConfig(args);
const db = d1(cfg, cfg.cloudflare.d1Engine);
const DRY = args.includes("--dry-run");
const I = { perRun: 4, model: "sonnet", maxOpen: 30, ...(cfg.ideas ?? {}) };
const PER_RUN = Number(argv("--per-run") ?? I.perRun);
const now = () => Date.now();
const ghEnv = { GH_TOKEN: process.env.DW_GH_TOKEN ?? process.env.GH_TOKEN ?? "" };

export const ANGLES = {
  competitors: "Study the leading competitors' feature pages, pricing pages, changelogs and templates. Find capabilities they have that we lack and that our users would actually use.",
  demand: "Find what people actually search for and ask about in this space: Google autocomplete and 'People also ask', Reddit, Quora, forums, YouTube how-tos. Find unmet needs and specific jobs people try to get done.",
  complaints: "Read what people hate about the alternatives: Trustpilot, G2, Capterra, app store reviews, Reddit threads. Find pains we could remove and turn into a reason to choose us.",
  adjacent: "Look at adjacent jobs: what people do right before and right after using a tool like ours, related tools they use alongside, new audiences or segments (by industry, country, occasion). Find natural extensions.",
  wild: "Propose bold, unconventional bets: new formats, delightful interactions, playful or surprising features, things no competitor does yet. Higher risk is fine; keep them honest and buildable.",
};

const prompt = ({ product, domain, brief, pages, titles, angle, n }) => `You are a product researcher for "${product}" (${domain}), a website that evolves itself: ideas become
mutants (built versions of the site) that compete on real and simulated visitors, and only the winners survive.
Your job is to feed that evolution with ideas.

## Brief
${brief.slice(0, 4000)}

## The site today (text of key pages)
${pages.slice(0, 10000)}

## Ideas already in the backlog (open or closed): don't repeat them
${titles.join("\n").slice(0, 8000) || "(none)"}

## Research angle for this run
${ANGLES[angle]}

Research properly before proposing: at least 8 searches and open the most relevant pages (not just snippets). Then propose up to ${n} ideas that:
- are NOT already in the backlog above (not even reworded);
- are honest (no dark patterns, no fake urgency or fake reviews) and buildable without paid external services or new API keys;
- would make real visitors more likely to succeed, come back, recommend us or pay.
Range from small to big (a whole feature or a redesign is welcome). Being wrong is cheap here: selection kills bad
ideas, so don't play it safe, but each idea needs real evidence.

Answer with ONLY JSON:
{"ideas":[{"title":"max 10 words","size":"small|medium|large|feature|redesign","body":"What to build (user-visible behaviour), why it should help, and the evidence with source URLs"}]}`;

async function fetchText(domain, p) {
  const r = await fetch(`https://${domain}${p}`).catch(() => null);
  if (!r?.ok) return "";
  return `### ${p}\n` + (await r.text()).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 3000);
}

async function issuesOf(repoSlug) {
  const r = await run("gh", ["issue", "list", "-R", repoSlug, "--state", "all", "--limit", "500", "--json", "number,title,state,labels,createdAt,comments"], { env: ghEnv, timeoutMs: 120_000 });
  return JSON.parse(r.out || "[]");
}

async function main() {
  fs.mkdirSync(path.join(cfg.workdir, ".tmp"), { recursive: true });
  const only = argv("--species");
  for (const sp of cfg.species.filter((s) => !only || s.id === only)) {
    const repoDir = path.join(cfg.workdir, sp.repo);
    const species = JSON.parse(fs.readFileSync(path.join(repoDir, "species.json"), "utf8"));
    const brief = fs.existsSync(path.join(repoDir, "BRIEF.md")) ? fs.readFileSync(path.join(repoDir, "BRIEF.md"), "utf8") : "";
    const repoSlug = `${cfg.github.org}/${sp.repo}`;
    const names = Object.keys(ANGLES);
    const done = (await db.first("SELECT COUNT(*) n FROM journal WHERE species=? AND kind='ideation'", [sp.id]))?.n ?? 0;
    const angle = ANGLES[argv("--angle")] ? argv("--angle") : names[done % names.length];

    let all = [];
    try {
      all = await issuesOf(repoSlug);
    } catch (e) {
      log(`[${sp.id}] ideation: backlog unavailable: ${e.message}`);
      continue;
    }
    const pages = (await Promise.all((sp.screenPages ?? ["/"]).map((p) => fetchText(sp.domain, p)))).join("\n");
    const r = await claudeStream({
      args: ["-p", prompt({ product: species.brand?.name ?? sp.id, domain: sp.domain, brief, pages, titles: all.map((i) => `- ${i.title}`), angle, n: PER_RUN }), "--model", I.model, "--allowedTools", "WebSearch,WebFetch"],
      cwd: path.join(cfg.workdir, ".tmp"),
      label: `${sp.id} ideation`,
      timeoutMs: 25 * 60_000,
      transcriptDir: path.join(cfg.workdir, ".tmp", "transcripts"),
    });
    if (limitHit(r)) {
      log("ideation: usage limit reached; stopping");
      break;
    }
    const seen = new Set(all.map((i) => i.title.toLowerCase().trim()));
    const ideas = (extractJson(r.out)?.ideas ?? []).filter((x) => x?.title && x?.body && !seen.has(String(x.title).toLowerCase().trim())).slice(0, PER_RUN);
    if (!DRY) await ensureLabels(repoSlug).catch(() => {});
    const filed = [];
    for (const idea of ideas) {
      const body = `${idea.body}\n\n**Suggested size:** ${idea.size ?? "medium"}\n\n_Found by the ideation loop (angle: ${angle}). Normal priority: it competes as a mutant and survives only if it wins._`;
      if (DRY) { log(`[${sp.id}] would file: ${idea.title}`); filed.push(idea.title); continue; }
      await createIssue(repoSlug, { title: idea.title, body, label: "from:ideation" }).then(() => filed.push(idea.title)).catch((e) => log(`ideation issue failed: ${e.message}`));
    }

    // Cap the open ideation backlog: close the oldest ideas nobody has engaged with.
    const open = all.filter((i) => i.state === "OPEN" && (i.labels ?? []).some((l) => l.name === "from:ideation")).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const excess = open.length + filed.length - I.maxOpen;
    const stale = open.filter((i) => !(i.comments ?? []).length).slice(0, Math.max(0, excess));
    for (const i of stale) if (!DRY) await closeIssue(repoSlug, i.number, "Closed to make room for newer ideas from the ideation loop (no mutant picked it up). Reopen to bring it back.").catch(() => {});

    const detail = `${angle}: ${filed.length ? filed.join(" | ") : "no new ideas"}${stale.length ? ` (closed ${stale.length} stale)` : ""}`;
    log(`[${sp.id}] ideation ${detail}`);
    if (!DRY) await db.run("INSERT INTO journal (ts, species, kind, arm_id, detail) VALUES (?,?,?,?,?)", [now(), sp.id, "ideation", null, detail.slice(0, 1500)]);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
