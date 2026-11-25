---
name: evolve-to-prs
description: Build one mutation for the Darwinian engine, fast, with no human in the loop. One mutation becomes one branch and one PR. Selection (simulated and real users) judges the result, not code quality, so skip ceremony and get a working change out.
metadata:
  version: "2.0.0"
  derived-from: "mohasarc/mo-skills work-to-prs 2.2.0 (heavily slimmed)"
---

# Evolve to PRs

Build one mutation end to end. There is no human anywhere in this loop: never ask questions or wait for approval.
Decide with the evidence you have, note the assumption, and keep going. The engine opens the PR, runs an automated
behaviour review and deploys the change; selection decides whether it lives. Code quality is not judged. What
matters is that the change works for real people and keeps the charter.

## Inputs (from the invoking prompt)

- Work item file: what to build and why, with acceptance criteria.
- Repository: the current directory, a clean worktree at the base SHA.
- Branch name, e.g. `arm/g3-abcd`.
- Run folder: an absolute path for notes and screenshots. Never commit it.

`config.md` beside this file lists the commands, capabilities and house rules. Read it first.

## Workflow

1. Read `config.md`, the work item, and the repository's `CLAUDE.md`, `CHARTER.md`, `BRIEF.md` and `LESSONS.md`.
   The charter is absolute. `LESSONS.md` lists mistakes earlier mutants made; don't repeat them.
2. Create the branch from the base SHA.
3. Make a short plan in your head or in `<run folder>/plan.md`: the thinnest version that delivers the work item.
   Don't add scope.
4. Build it. Commit whenever it helps, with any granularity; messages just say what changed. Add tests for the new
   behaviour so later mutants can't silently break it.
5. Check it like a user would: run `npm run dev` and use the browser tools at phone (390 px) and laptop widths.
   Click through the new flow, the core flows, and the empty and error states.
6. Make `npm test`, `npm run typecheck`, `npm run build` and `npm run e2e` pass. A mutant that fails them never
   reaches anyone.
7. Write `result.json` last (below).

Do the work yourself. Use subagents only for genuinely parallel research, and wait for every one you start. Never
end your turn while one is still running.

## Finish

Write `<run folder>/result.json`:

```json
{
  "branch": "arm/g3-abcd",
  "head": "<sha>",
  "title": "short PR title in plain words",
  "summary": "one paragraph: what changed for users and why",
  "checks": "commands run and their final status",
  "assumptions": ["..."]
}
```

If the work turned out to be impossible or unsafe, still write result.json with `"head": null` and the reason in
`summary`.

## Boundaries

- Never push, open PRs, merge, delete branches or discard work. The engine publishes.
- Never modify the protected paths listed in `species.json` (`protected`). New migrations may only add.
