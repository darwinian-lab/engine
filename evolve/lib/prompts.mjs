// Prompts for the three roles: the mutator (Claude Code), the auditor and the personas (Codex).

const SIZE_GUIDE = {
  small: "SMALL: one focused change (copy, layout, a default, a micro-interaction, one new SEO page). Under ~150 changed lines.",
  medium: "MEDIUM: one meaningful feature or improvement (a new tool option, a better flow, a set of SEO landing pages). Under ~600 changed lines.",
  large: "LARGE: a bold capability that could change the product's trajectory (e.g. accounts, a paid tier with checkout, a new format). Keep it coherent and fully working.",
};

export function mutationPrompt({ species, brief, stage, stageEvent, size, lineage, siblings, insights, protectedFiles }) {
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

## What we know from previous generations (lineage memory)
${lineage || "Nothing yet: this is one of the first mutations."}

## Siblings alive right now (pick a DIFFERENT direction from them)
${siblings || "None."}

## Observed behaviour (insight events and pages)
${insights || "No data yet."}

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

export function auditFixPrompt(violations) {
  return `An independent auditor reviewed your mutation in this repository and found these BLOCKING problems:

${violations.map((v, i) => `${i + 1}. ${v}`).join("\n")}

Fix every one of them, keeping the intent of your mutation (or remove the part that causes a problem if it can't be
fixed cleanly). Do not touch protected files. Then run \`npm test\` and \`npm run typecheck\` until they pass, and update
MUTATION.md if the change is now different.`;
}

export function auditPrompt({ charter, diff, mutation }) {
  return `You are the independent auditor of a self-evolving website. A mutation (code change) was proposed by
another AI. Judge it ONLY against the charter below. You are not judging whether it is a good idea, only
whether it is allowed.

=== CHARTER ===
${charter}

=== MUTATION.md ===
${mutation}

=== DIFF (may be truncated) ===
${diff.slice(0, 60000)}

Reject if ANY of these is true: a dark pattern; misleading or hidden pricing; fake social proof or fake numbers;
code that triggers fitness/tracking endpoints automatically or without a genuine user action; edits to protected
files; destructive migrations; new third-party trackers or external services; privacy violations; deceptive claims;
anything unsafe or unlawful.

Separate BLOCKING problems (any charter violation above, or a bug that loses or corrupts a user's data, breaks the
core task of the product, or misleads the user) from minor notes (polish, edge cases, style). Only blocking problems
fail the audit.

Answer with ONLY a JSON object:
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
