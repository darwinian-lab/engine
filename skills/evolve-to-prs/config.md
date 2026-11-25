# Evolve-to-PRs rules

## Reading work items
- The work item is a file named in the invoking prompt. There is no tracker access. Never ask a human.

## Models
- Planner: default
- Companion: sonnet
- Implementer: sonnet
- Reviewer: default
- Grouper: sonnet

## Publication
- Never push or open PRs. The engine publishes from result.json.

## Runs
- Folder: the run folder named in the invoking prompt. Keep everything.

## Review
- Every phase except the final phase gets at most two reviewer rounds.
- Material findings remaining after round two carry into the next phase.
- The final phase gets at most four reviewer rounds; anything still open is reported in result.json.

## PR size
- Target: ~10 commits, ~500 changed lines. Ceiling: 20 commits.
- Readability decides within the budget. Test commits and lines count in full.
- Strictness: firm.

## Conventions
- Integration branch: the base SHA named in the invoking prompt.
- Branch naming: `<prefix>-part-<nn>[-<slug>]` with the prefix from the invoking prompt.
- Verification commands: `npm test`, `npm run typecheck`, `npm run build`, `npm run e2e`.

## Capabilities
- Local site: `npm run dev` serves the site at http://127.0.0.1:8787 with a local database.
- Browser: the `browser` MCP tools (Playwright) can open the local site. Use them to see and click through every
  visual or interaction change at phone (390 px) and laptop widths. Save before/after screenshots for visual changes
  to the part's `visuals/` folder.
- Documentation: WebFetch is allowed for docs on hono.dev, developers.cloudflare.com, clerk.com,
  developer.mozilla.org, web.dev and playwright.dev only.
- Code navigation: Read, Glob, Grep.

## Extra guidance
- There is no human. Never ask questions; decide with evidence, record assumptions, continue.
- Read `CLAUDE.md`, `CHARTER.md`, `BRIEF.md` and `LESSONS.md` in the repository first. The charter's laws are absolute.
  `LESSONS.md` lists mistakes earlier mutants made: do not repeat them.
- Never modify protected paths listed in `species.json` (`protected`). New migrations may only add.
- The end-to-end core flows (`npm run e2e`) must pass at every phase end, not only at the end.
- Browser code: any value used after an await, timer or debounce must be checked against the current input/session
  at the moment it is used. Downloads, exports and saves always use the current state.
- Coding style: test first for behaviour; readable names; early returns; no magic numbers; named booleans for
  multi-part conditions; options objects for more than one optional parameter; no side effects in ternaries; delete
  what a change leaves unused; reuse existing utilities and terms; match the surrounding style in existing files.
- Build in vertical slices: the thinnest end-to-end happy path first, then deepen. Don't build ahead of consumers.
- PR descriptions: cover this PR only; one concrete fact per sentence; skip empty sections; UI changes include
  before/after screenshots from `visuals/`; no mention of AI or agents.
