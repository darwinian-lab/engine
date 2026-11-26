// Prompts for the three roles: the mutator (Claude Code), the auditor and the personas (Codex).

const SIZE_GUIDE = {
  small: "SMALL: one focused change (copy, layout, a default, a micro-interaction, one new SEO page). Under ~150 changed lines.",
  medium: "MEDIUM: one meaningful feature or improvement (a new tool option, a better flow, a set of SEO landing pages). Under ~600 changed lines.",
  large: "LARGE: a bold capability that could change the product's trajectory (e.g. accounts, a paid tier with checkout, a new format). Keep it coherent and fully working.",
};

export function mutationPrompt({ species, brief, stage, stageEvent, size, lineage, siblings, insights, protectedFiles, backlog, simFeedback, revival }) {
  return `# You are a mutation in a Darwinian software experiment

This repository is one product ("${species.brand.name}", ${species.brand.domain}). Several variants of it
run at the same time on the real domain. A router sends real visitors to each variant and measures what they do.
Variants that create more value survive and become parents; the rest are retired. You are creating a new child
of the current parent. Read CHARTER.md first: its laws are absolute, and breaking them gets you rejected before
you ever see a visitor.

## The product brief
${brief}

## How survival is judged right now
Current fitness stage: **${stage}**. A visitor counts as a success when they genuinely ${stageEvent}.
Later stages reward deeper value (sign-ups, then revenue). Measurement happens in the router from real requests;
you cannot and must not influence it except by making the product better for real people.

Until there are enough real visitors, simulated people also judge you: AI agents with realistic personas use the
site in real browsers (phones and laptops), try to get a real job done, sometimes come back days later on another
device, and report where they got stuck and what they wished for. They succeed only if they get the job done,
the router sees it happen, and they are genuinely happy with it. You cannot see or detect them; just build for people.

## What we know from previous generations (lineage memory)
${lineage || "Nothing yet: this is one of the first mutations."}

## Siblings alive right now (pick a DIFFERENT direction from them)
${siblings || "None."}

## Observed behaviour (insight events and pages)
${insights || "No data yet."}

## What simulated people said about the current parent (recent sessions)
${simFeedback || "No simulated sessions yet."}

## The backlog (feature requests and problems; owner requests first)
${backlog || "Empty."}
You may implement one backlog item (say so in MUTATION.md) or pursue your own hypothesis.${revival ? `

## THIS IS A REVIVAL
An earlier mutant tried the idea below and died (cause: ${revival.cause}). Conditions have changed since then
(new champion code, ${revival.generations} generation(s) later). Re-introduce the SAME idea on top of the current code,
adapting it to what the code looks like now and fixing whatever made it fail if the cause suggests a fix.

### Its MUTATION.md
${revival.mutation}

### Its original diff (for reference; the code has moved on, do not apply blindly)
${revival.diff ? revival.diff.slice(0, 30000) : "(not kept: it never reached deployment)"}` : ""}

## Your mutation
Size: ${SIZE_GUIDE[size]}

1. Choose ONE hypothesis about what would make more real visitors succeed. Prefer ideas the lineage hasn't tried,
   or a better execution of an idea that showed promise.
2. Implement it fully. Keep the product fast, accessible, mobile-friendly and honest.
3. Do NOT modify these protected paths: ${protectedFiles.join(", ")}. New database migrations may only ADD
   (new numbered file in migrations/, CREATE TABLE / ADD COLUMN / CREATE INDEX only).
4. No new external services, API keys, trackers or paid dependencies. Small pure-JS npm packages that work on
   Cloudflare Workers are OK.
5. Run \`npm test\` and \`npm run typecheck\` and make them pass. You may add your own tests.
6. Finally write MUTATION.md (overwrite it) in exactly this format:

   # <short title, max 8 words>
   **Implements:** #<issue number>   (only if you implemented a backlog item; omit the line otherwise)
   **Hypothesis:** <one or two sentences: what you changed and why it should help real visitors>
   **Changes:** <bullet list>
   **Expected effect:** <which behaviour should go up>

Do not ask questions. Make the decision yourself and finish the work.`;
}

export function repairPrompt(failure) {
  return `Your changes in this repository fail the viability gates. Fix them WITHOUT touching protected files
(species.json, src/_dw.ts, CHARTER.md, test/protected.test.ts, wrangler.toml, existing migrations).
If a protected file was modified, restore it with \`git checkout HEAD -- <file>\`.
Keep the intent of your mutation. Then run \`npm test\` and \`npm run typecheck\` until they pass.

Failure output:
\`\`\`
${failure.slice(-6000)}
\`\`\``;
}

export function auditFixPrompt(violations, round = 1, earlier = []) {
  return `An independent auditor reviewed your mutation in this repository and found these BLOCKING problems
(review round ${round}):

${violations.map((v, i) => `${i + 1}. ${v}`).join("\n")}
${earlier.length ? `
Earlier rounds already flagged the following, and your previous fixes did not fully resolve everything. Make sure
the root cause is fixed this time (not just the symptom), and add a test that proves it:
${earlier.flat().map((v) => `- ${v}`).join("\n")}
` : ""}
Fix every one of them, keeping the intent of your mutation (or remove the part that causes a problem if it can't be
fixed cleanly). Do not touch protected files. Then run \`npm test\` and \`npm run typecheck\` until they pass, and update
MUTATION.md if the change is now different.`;
}

export function auditPrompt({ charter, diff, mutation, earlier = "" }) {
  return `You are the independent auditor of a self-evolving website. A mutation (code change) was proposed by
another AI. Judge it ONLY against the charter below. You are not judging whether it is a good idea, only
whether it is allowed.

=== CHARTER ===
${charter}

=== MUTATION.md ===
${mutation}

=== DIFF (may be truncated) ===
${diff.length > 150000 ? `${diff.slice(0, 150000)}
[... diff truncated: ${diff.length - 150000} more characters. Judge only what you can see; do not block on what you could not see.]` : diff}

Reject if ANY of these is true: a dark pattern; misleading or hidden pricing; fake social proof or fake numbers;
code that triggers fitness/tracking endpoints automatically or without a genuine user action; edits to protected
files; destructive migrations; new third-party trackers or external services; privacy violations; deceptive claims;
anything unsafe or unlawful.

Separate BLOCKING problems (any charter violation above, or a bug that loses or corrupts a user's data, breaks the
core task of the product, or misleads the user) from minor notes (polish, edge cases, style). Only blocking problems
fail the audit.

${earlier ? `=== EARLIER AUDIT ROUNDS ON THIS CHANGE ===
${earlier.slice(0, 12000)}

This is a re-audit after fixes. First check whether each earlier blocking problem is fixed; keep it only if it is
not. Raise a NEW blocking problem only for a clear charter violation (dark pattern, deception, privacy breach, fake
proof, tracking without consent, protected-file edits, destructive migrations). Ordinary bugs and edge cases are the
code reviewer's job, not yours: list them as notes. Do not move the goalposts: anything you could have raised in an
earlier round is a note now.

` : ""}Answer with ONLY a JSON object:
{"verdict":"pass"|"fail","violations":["blocking problem, specific and actionable", ...],"notes":["minor note", ...],"summary":"one sentence describing the change"}`;
}

export function personaPrompt({ brand, parentText, childText, mutation }) {
  return `Three different people are deciding between two versions of the website "${brand.name}" (${brand.tagline ?? ""}).
Each person reads both versions' pages and picks the one they'd rather use, and how strongly.

Personas:
1. A busy small-business owner, not technical, on a phone.
2. A careful, skeptical person who hates hidden costs and spam.
3. A first-time visitor who arrived from a Google search and wants the job done fast.

What changed in version B: ${mutation.slice(0, 1500)}

=== VERSION A (current) ===
${parentText.slice(0, 12000)}

=== VERSION B (proposed) ===
${childText.slice(0, 12000)}

Answer with ONLY a JSON object:
{"votes":[{"persona":1,"prefers":"A"|"B"|"same","strength":1-5,"why":"..."}, ...3 items],"broken":true|false,"broken_reason":"..."}
Set broken=true only if version B looks broken, empty, garbled or unusable.`;
}


export function simPrompt({ persona, phase, actor, device, url, memory, received, email, budget }) {
  return `You are role-playing a real person using a website, in a real browser you control through the browser tools.
Stay in character the whole time. You are NOT a tester or a developer.

## Who you are
${actor ? actor + "." : persona.who}
${actor ? "(This is a different person from the site owner in earlier steps.)" : ""}
Device: ${device === "mobile" ? "a phone" : "a laptop"}.

## Situation (${phase.label})
${phase.task}
${memory ? `\nWhat you remember or have from before:\n${memory}` : ""}${received ? `\nMessage you received:\n${received}` : ""}

## Start here
Open ${url}

## How to behave
- Act like this person would: read what they would read, click what they would click, give up when they would give up.
  Realistic patience: about ${budget} actions for this step at most.
- Never open developer tools, view page source, or type URLs a normal person couldn't know. Using links the site
  shows you, or ones you were given, is fine. Searching the web is not available.
- When you need personal details, invent realistic ones. Use the email ${email} if an email is needed.
  If a verification code is ever asked for, try 424242.
- Do not pay for anything.

## Rating scale (be honest and use the whole scale; most sites deserve a 3)
1 = I failed or would never come back. 2 = I got there but it was frustrating. 3 = it worked, nothing special,
I'd use something else just as happily. 4 = clearly good: fast, obvious, I'd come back. 5 = delighted, I'd recommend it
to a friend. Think about what this person would compare it with (the sites they usually use).

## When you are finished (or give up)
Reply with ONLY this JSON, nothing else:
{"done": true|false, "gave_up": "reason, or empty", "stuck": ["specific moments you were confused or blocked"],
 "wishes": ["things you wished the site did or had"], "liked": ["things that worked well"], "rating": 1-5 (see scale),
 "remember": "what you would realistically remember or still have next time (including any links you saved)",
 "share": "exactly what you would send to someone else, if anything (e.g. a link with a short message)",
 "summary": "2-3 sentences in first person about how it went"}`;
}

export function curatorPrompt({ product, issues, feedback }) {
  return `You maintain the feature-request backlog of "${product}". Simulated users just used the site and reported
problems and wishes. Turn them into backlog actions.

## Open issues
${issues.map((i) => `#${i.number} [${(i.labels || []).join(",")}] ${i.title}`).join("\n") || "(none)"}

## New feedback (persona: item)
${feedback.join("\n")}

Rules: merge duplicates; if an item matches an open issue, upvote that issue instead of creating a new one;
create at most 3 new issues, only for items that are specific and would clearly help real users; ignore vague or
one-off complaints. Titles are short and user-centred ("Let me get back to my wall from another device").

Answer with ONLY JSON:
{"actions":[{"op":"create","title":"...","body":"problem, who hit it, suggested direction"},{"op":"upvote","number":12,"note":"who hit it and how"}]}`;
}

export function ideationPrompt({ product, brief, pages, issues, probes }) {
  return `You are the product strategist of "${product}", a self-evolving website. Propose new ideas for its backlog.

## Brief
${brief.slice(0, 4000)}

## The site today (text of key pages)
${pages.slice(0, 12000)}

## Open backlog
${issues.map((i) => `#${i.number} ${i.title}`).join("\n") || "(none)"}

## AI-search probes (what assistants recommend instead of us)
${probes || "(none)"}

Use web search to look at what competitors offer and what people ask for. Propose at most 2 ideas that are NOT
already in the backlog, are honest (no dark patterns), could be built without paid external services, and would
make real visitors more likely to succeed or come back. Answer with ONLY JSON:
{"ideas":[{"title":"...","body":"why, evidence (with source URLs), what to build"}]}`;
}

// ---------------------------------------------------------------------------------------------------------
// PR pipeline: hypothesis → evolve-to-prs build → automated PR review with feedback commits.
// ---------------------------------------------------------------------------------------------------------

export function hypothesisPrompt(ctx) {
  const body = mutationPrompt(ctx).split("## Your mutation")[0];
  return `${body}## Your job: choose this mutation's hypothesis (do not write code)

You are the first step of building one mutant. Study the repository (CLAUDE.md, CHARTER.md, BRIEF.md, LESSONS.md and
the code), then choose ONE hypothesis about what would make more real people succeed. Size: ${ctx.size}.
Prefer a backlog item when one fits (owner requests first), or a clear idea from what simulated people struggled with.
Pick a direction different from the siblings. Be concrete enough that a separate team can build it without you.

Answer with ONLY a JSON object:
{"title": "max 8 words", "hypothesis": "what changes and why it should help real people (2-3 sentences)",
 "work_item": "the full work description for the builders: user-visible behaviour, scope, out of scope, constraints, risks",
 "acceptance_criteria": ["observable criteria"], "implements_issue": <issue number or null>, "size": "small|medium|large"}`;
}

export function buildPrompt({ workItemFile, baseSha, branch, runDir }) {
  return `Use the evolve-to-prs skill (installed in your skills) to implement the work item in ${workItemFile}.

- Repository: the current directory (clean worktree at the base).
- Base SHA: ${baseSha}
- Branch: ${branch}
- Run folder: ${runDir}

There is no human. Work autonomously to the end and write ${runDir}/result.json as the skill describes.`;
}

export function prReviewPrompt({ workItem, baseSha, headSha, prBodies, history }) {
  return `Follow the runbook in ~/.claude/skills/evolve-to-prs/pr-reviewer.md.

The repository (current directory) is at the PR's head ${headSha}; the base is ${baseSha}
(review \`git diff ${baseSha}...${headSha}\` and \`git log ${baseSha}..${headSha}\`).

## Work item
${workItem}

## PR description
${prBodies.slice(0, 12000)}

## Earlier review rounds and the author's dispositions
${history || "None: this is the first round."}`;
}

export function addressPrompt({ findings, round }) {
  return `Follow the runbook in ~/.claude/skills/evolve-to-prs/address-feedback.md (review round ${round}).

## Findings
${findings.map((f) => `- ${f.id} [${f.blocking ? "BLOCKING" : "non-blocking"}, ${f.severity ?? ""}] ${f.file ?? ""}${f.line ? ":" + f.line : ""}: ${f.problem} → ${f.fix ?? ""}`).join("\n")}`;
}

export function lessonsPrompt({ product, current, items }) {
  return `You maintain LESSONS.md for "${product}", a self-evolving website. It tells future mutants which mistakes
earlier mutants made, so they don't repeat them.

## Current LESSONS.md
${current}

## New evidence from this cycle (review findings, rejections, failed checks, simulated users' problems)
${items.join("\n").slice(0, 20000)}

Rewrite LESSONS.md: keep the header line and intro, then at most 30 bullets, newest/most important first. Each bullet is
one general, actionable rule with the concrete failure it prevents ("Downloads must use the current render: a click
within 150 ms of an edit exported the previous code"). Merge duplicates; drop one-off trivia. Output ONLY the file content.`;
}
