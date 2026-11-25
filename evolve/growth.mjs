#!/usr/bin/env node
// Growth loop: evolution applied to acquisition.
//
// Every acquisition idea (a directory listing, a community post, a landing page for a search query...) is a
// growth item with its own ref code, so every real visitor it brings is attributed to it. Each run:
//   1. Measure: real visitors (after a real interaction) and fitness events per item.
//   2. Select: Thompson sampling over channels (visitors per item) decides where the next ideas go.
//   3. Breed: an agent with web search proposes new items for those channels, learning from what worked.
//      Owned items (landing pages) go to the species backlog and the engine builds them.
//      External items wait in the lab's growth queue: a person posts them (transparently, as the maker).
//   4. Retire items after their window; their numbers stay as evidence.
//
//   node evolve/growth.mjs [--species qr] [--per-run 4] [--dry-run]
import fs from "node:fs";
import path from "node:path";
import { d1 } from "./lib/d1.mjs";
import { loadConfig, ENGINE_DIR } from "./lib/config.mjs";
import { run, rid, log, extractJson, limitHit } from "./lib/util.mjs";
import { claudeStream } from "./lib/stream.mjs";
import { ensureLabels, createIssue } from "./lib/issues.mjs";

const args = process.argv.slice(2);
const argv = (k) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const cfg = loadConfig(args);
const db = d1(cfg, cfg.cloudflare.d1Engine);
const DRY = args.includes("--dry-run");
const G = { perRun: 4, windowDays: 30, model: "sonnet", maxProposed: 12, ...(cfg.growth ?? {}) };
const PER_RUN = Number(argv("--per-run") ?? G.perRun);
const now = () => Date.now();

const CHANNELS = {
  landing: { kind: "owned", what: "a new page on our own site that answers one specific search query people really type (verify with web search that people search for it and what currently ranks). The engine builds it." },
  directory: { kind: "external", what: "a free listing on a software/tool directory or 'alternatives to X' site (no paid placements). Check the site accepts submissions and how." },
  community: { kind: "external", what: "a genuinely useful post or comment in a community where the target users gather (subreddits, forums, Discord/Slack groups, Facebook groups). Read and follow its self-promotion rules; disclose being the maker." },
  qa: { kind: "external", what: "an answer to an existing, recent question (Reddit, Quora, Stack Exchange, forums) where the tool truly solves the asker's problem. Link only if it helps; disclose being the maker." },
  social: { kind: "external", what: "a post for the brand's own social accounts (X, Bluesky, Threads, LinkedIn): something useful or interesting in itself, not an ad." },
  outreach: { kind: "external", what: "a short, personal email to a newsletter, blog or resource list that features tools like this and accepts suggestions." },
  launch: { kind: "external", what: "a launch listing (Product Hunt, BetaList, Indie Hackers 'products', etc.). Not Hacker News." },
};

// Gamma sampler (Marsaglia-Tsang) for Thompson sampling over channels: humans per item ~ Poisson(rate), rate ~ Gamma.
function gamma(k) {
  if (k < 1) return gamma(1 + k) * Math.pow(Math.random(), 1 / k);
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do {
      let u = 0;
      while (u === 0) u = Math.random();
      x = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

async function ensureSchema() {
  const sql = fs.readFileSync(path.join(ENGINE_DIR, "migrations", "0006_growth.sql"), "utf8").replace(/--.*$/gm, "");
  for (const stmt of sql.split(";").map((x) => x.trim()).filter(Boolean)) await db.run(stmt);
}

const journal = (species, detail) => (DRY ? log(`[journal] ${detail}`) : db.run("INSERT INTO journal (ts, species, kind, arm_id, detail) VALUES (?,?,?,?,?)", [now(), species, "growth", null, detail]));

/** Real visitors an item brought, and how many of them reached the fitness event. */
async function measure(sp, item, stageEvent) {
  const since = item.live_at ?? item.created_at;
  // External items: visitors who arrived with the item's ref. Owned pages: visitors who entered on that page from outside.
  const entry = item.kind === "owned"
    ? ["SELECT DISTINCT visitor FROM events WHERE species=? AND name='pageview' AND ts>=? AND segment!='sim' AND path=? AND json_extract(props,'$.src') NOT IN ('internal','direct')", [sp.id, since, item.link]]
    : ["SELECT DISTINCT visitor FROM events WHERE species=? AND name='pageview' AND ts>=? AND segment!='sim' AND json_extract(props,'$.src')=?", [sp.id, since, item.id]];
  const visitors = `(${entry[0]})`;
  const humans = (await db.first(`SELECT COUNT(DISTINCT visitor) n FROM events WHERE species=? AND name='js_seen' AND ts>=? AND visitor IN ${visitors}`, [sp.id, since, ...entry[1]]))?.n ?? 0;
  const successes = (await db.first(`SELECT COUNT(DISTINCT visitor) n FROM events WHERE species=? AND name=? AND ts>=? AND visitor IN ${visitors}`, [sp.id, stageEvent, since, ...entry[1]]))?.n ?? 0;
  return { humans, successes };
}

/** Thompson sampling: which channels get this run's new ideas. Untried channels start optimistic. */
function pickChannels(items, n) {
  const stats = Object.fromEntries(Object.keys(CHANNELS).map((c) => [c, { items: 0, humans: 0 }]));
  for (const it of items) if (it.status === "live" || it.status === "retired") {
    stats[it.channel].items++;
    stats[it.channel].humans += it.humans;
  }
  const picks = [];
  for (let i = 0; i < n; i++) {
    let best = null, bd = -1;
    for (const [c, s] of Object.entries(stats)) {
      const draw = gamma(1 + s.humans) / (1 + s.items);
      if (draw > bd) { bd = draw; best = c; }
    }
    picks.push(best);
  }
  return { picks, stats };
}

function prompt({ sp, species, brief, stage, items, picks, stats }) {
  const past = items.slice(0, 40).map((it) => `- [${it.status}] ${it.channel} → ${it.target ?? "?"}: ${it.angle ?? it.title ?? ""} (${it.humans} visitors, ${it.successes} reached "${stage.event}")`).join("\n") || "None yet.";
  const counts = picks.reduce((m, c) => ((m[c] = (m[c] ?? 0) + 1), m), {});
  return `You run acquisition experiments for the website "${species.brand.name}" (https://${sp.domain}). ${species.brand.tagline ?? ""}

## The product
${brief.slice(0, 3500)}

Success for a visitor right now: ${stage.describe ?? stage.event}.

## How this works
Acquisition evolves like the product does. Every idea is an experiment with its own tracked link; ideas that bring
real people who then succeed are repeated and varied, the rest fade. Results so far:
${past}

Channel totals (items live or finished, real visitors brought):
${Object.entries(stats).map(([c, s]) => `- ${c}: ${s.items} items, ${s.humans} visitors`).join("\n")}

## Your job
Propose exactly these new items: ${Object.entries(counts).map(([c, n]) => `${n} × ${c}`).join(", ")}.
Channels:
${Object.entries(counts).map(([c]) => `- ${c}: ${CHANNELS[c].what}`).join("\n")}

Use web search to find real, current targets (the actual directory, the actual community and its rules, the actual
question thread, the actual query people search). Each item needs a distinct angle: who exactly it reaches and why
they would care. Vary what worked; don't repeat what got nothing. Write the post text ready to publish, in plain,
human, specific language, in the target's own format and norms.

## Hard rules
- Honest and transparent: posts are by the maker of the tool and say so. No fake users, reviews, testimonials,
  upvote requests, sockpuppets or disguised ads. Follow each target's self-promotion rules; skip targets that ban it.
- No paid placements. No Hacker News. Never mention that the product evolves itself or is built by AI agents
  (the owner tells that story personally, later).
- No spam: at most one item per target. Prefer giving real value (an answer, a guide) over announcing.
- Put {link} where the tracked link goes (at most once per item). For landing pages, give the page path instead.

Answer with ONLY JSON:
{"items":[{"channel":"...","target":"name of the directory/community/query","target_url":"https://... (where to post or the thread)","angle":"who it reaches and why it should work","title":"post title or page title","body":"ready-to-post text with {link}, or for landing pages: what the page must contain","path":"/landing-path (landing only, or the page the link should open)","rules":"the target's relevant rules, as you checked them"}]}`;
}

async function propose(sp, species, brief, stage, items, picks, stats) {
  const r = await claudeStream({
    args: ["-p", prompt({ sp, species, brief, stage, items, picks, stats }), "--model", G.model, "--allowedTools", "WebSearch,WebFetch"],
    cwd: path.join(cfg.workdir, ".tmp"),
    label: `${sp.id} growth`,
    timeoutMs: 20 * 60_000,
    transcriptDir: path.join(cfg.workdir, ".tmp", "transcripts"),
  });
  if (limitHit(r)) throw new Error("usage limit");
  return extractJson(r.out)?.items ?? [];
}

async function main() {
  await ensureSchema();
  fs.mkdirSync(path.join(cfg.workdir, ".tmp"), { recursive: true });
  const only = argv("--species");
  for (const sp of cfg.species.filter((s) => !only || s.id === only)) {
    const repoDir = path.join(cfg.workdir, sp.repo);
    const species = JSON.parse(fs.readFileSync(path.join(repoDir, "species.json"), "utf8"));
    const brief = fs.existsSync(path.join(repoDir, "BRIEF.md")) ? fs.readFileSync(path.join(repoDir, "BRIEF.md"), "utf8") : "";
    const st = await db.first("SELECT stage FROM species_state WHERE species=?", [sp.id]);
    const stage = species.stages[Math.min(st?.stage ?? 0, species.stages.length - 1)];
    const repoSlug = `${cfg.github.org}/${sp.repo}`;

    // 1. Measure; owned pages go live once the champion serves them; retire after the window.
    let items = await db.all("SELECT * FROM growth_items WHERE species=? ORDER BY created_at DESC", [sp.id]);
    for (const it of items) {
      if (it.kind === "owned" && it.status === "proposed") {
        const res = await fetch(`https://${sp.domain}${it.link}`, { redirect: "manual" }).catch(() => null);
        if (res?.status === 200 && !DRY) {
          await db.run("UPDATE growth_items SET status='live', live_at=? WHERE id=?", [now(), it.id]);
          Object.assign(it, { status: "live", live_at: now() });
          await journal(sp.id, `landing page ${it.link} is live (${it.target})`);
        }
      }
      if (it.status !== "live") continue;
      const m = await measure(sp, it, stage.event);
      const old = now() - (it.live_at ?? it.created_at) > G.windowDays * 86400_000;
      if (!DRY) await db.run("UPDATE growth_items SET humans=?, successes=?, measured_at=?, status=?, retired_at=? WHERE id=?", [m.humans, m.successes, now(), old ? "retired" : "live", old ? now() : null, it.id]);
      Object.assign(it, m, old ? { status: "retired" } : {});
    }

    // 2. Select channels; don't pile up unposted items.
    const waiting = items.filter((it) => it.status === "proposed" && it.kind === "external").length;
    const room = Math.max(0, Math.min(PER_RUN, G.maxProposed - waiting));
    const { picks, stats } = pickChannels(items, room);
    const ownedRoom = items.filter((it) => it.kind === "owned" && it.status === "proposed").length >= 3;
    const chosen = picks.map((c) => (ownedRoom && c === "landing" ? "directory" : c));
    log(`[${sp.id}] growth: ${items.length} items, ${waiting} waiting to be posted; breeding ${chosen.join(", ") || "nothing"}`);
    if (!chosen.length) continue;

    // 3. Breed new items.
    let proposals = [];
    try {
      proposals = await propose(sp, species, brief, stage, items, chosen, stats);
    } catch (e) {
      log(`[${sp.id}] growth proposal failed: ${e.message}`);
      if (/usage limit/.test(e.message)) break;
      continue;
    }
    const seen = new Set(items.map((it) => (it.target_url ?? it.target ?? "").toLowerCase()));
    const added = [];
    for (const p of proposals) {
      const ch = CHANNELS[p.channel] ? p.channel : null;
      const key = (p.target_url ?? p.target ?? "").toLowerCase();
      if (!ch || !p.body || (key && seen.has(key))) continue;
      seen.add(key);
      const id = `g${rid(5).toLowerCase()}`;
      const owned = CHANNELS[ch].kind === "owned";
      const pagePath = (p.path && p.path.startsWith("/") ? p.path : "/").split("?")[0];
      const link = owned ? pagePath : `https://${sp.domain}${pagePath}?ref=${id}`;
      const body = owned ? p.body : String(p.body).includes("{link}") ? String(p.body).replaceAll("{link}", link) : `${p.body}\n\n${link}`;
      let issue = null;
      if (owned && !DRY) {
        await ensureLabels(repoSlug).catch(() => {});
        issue = await createIssue(repoSlug, {
          title: `Landing page: ${p.title ?? p.target}`.slice(0, 120),
          body: `**Search query:** ${p.target}\n**Path:** \`${pagePath}\`\n**Why:** ${p.angle}\n\n${p.body}\n\nBuild this as a real, useful page at exactly \`${pagePath}\`, linked from the site's footer or a relevant page, included in the sitemap, with a clear path to the core action. Its success is measured by real visitors who arrive on it from search or AI assistants.\n\n_Proposed by the growth loop (item \`${id}\`)._`,
          label: "from:growth",
        }).catch((e) => (log(`growth issue failed: ${e.message}`), null));
      }
      const row = [id, sp.id, ch, owned ? "owned" : "external", p.target ?? null, p.target_url ?? null, p.angle ?? null, p.title ?? null, body, link, p.rules ?? null, "proposed", now(), issue ? Number(String(issue).split("/").pop()) || null : null];
      if (!DRY) await db.run("INSERT INTO growth_items (id, species, channel, kind, target, target_url, angle, title, body, link, rules, status, created_at, issue) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", row);
      added.push(`${ch} → ${p.target}`);
    }
    if (added.length) await journal(sp.id, `growth: ${added.length} new idea(s): ${added.join(" | ")}`.slice(0, 1500));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
