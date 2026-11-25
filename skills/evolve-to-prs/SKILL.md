---
name: evolve-to-prs
description: Autonomous adaptation of work-to-prs for the Darwinian engine. Take one mutation's work item through private two-agent planning, phased TDD implementation and per-phase review, with no human in the loop. One mutation is one branch and one PR. Leaves the branch plus a result.json; the engine publishes and runs PR review.
metadata:
  version: "2.1.0"
  derived-from: "mohasarc/mo-skills work-to-prs 2.2.0"
---

# Evolve to PRs

Implement one mutation end to end. There is no human anywhere in this loop: never ask questions, never wait for
approval, make the best evidence-backed decision and record it. The engine that invoked you publishes the branch,
opens the PR and runs PR review after you finish; you never push.

No human reads this code. Selection (simulated and real people) decides whether the mutant lives. So the work must
be correct and keep the charter. Follow the commit rules (`methods/commit-rules.md`) and keep the description short,
but nobody enforces or reviews them: never spend time reshaping history or polishing text.

## Inputs (from the invoking prompt)

- Work item file (the hypothesis: what to build and why, acceptance criteria, backlog issue if any).
- Repository (the current directory, a clean worktree at the base SHA), base SHA, branch name (e.g. `arm/g3-abcd`).
- Run folder (absolute path) for all artifacts. Never commit it.

## Config

`config.md` beside this file holds the rules. Read it first. Its Extra guidance passes verbatim to every agent.

When you start a subagent, set its model from `config.md` Models (`default` means inherit yours). Always wait for
every subagent you started before you finish; never end your turn while one is still running, and write
`result.json` last.

## Agents

Spawn subagents with the Task tool, passing the role's runbook file path and the run folder. Roles: planner
(+ companion, spawned by the planner), implementer, reviewer. Each spawn is fresh; only the implementer is resumed,
and only for review fixes within its phase. If subagents are unavailable, play the roles sequentially.

## Boundaries

- Run phases and reviews sequentially.
- Never push, create PRs, merge, delete branches, stash, or discard work.
- The orchestrator reads only the brief, phased plan, run config, git status, completion notes and review verdicts.
  Anything that needs the diff goes to a subagent.
- Never modify protected files listed in `species.json` (`protected`).

## Workflow

### Preflight and planning

1. Read `config.md`, the work item, and the repository's `CLAUDE.md`, `CHARTER.md`, `BRIEF.md`, `LESSONS.md`.
2. Confirm a clean working tree. Create the branch from the base SHA.
3. Spawn the planner with `planner.md`. It writes `brief.md`, `phased-plan.md`, `planning-dialogue.md` in the run
   folder and returns plan path, phase count and material assumptions.
4. Create `run-config.md` from `templates/run-config.md`.

Keep the plan proportionate: a small mutation is usually one or two phases. Do not invent scope beyond the work item.

### Each phase

1. Record the phase base.
2. Spawn a fresh implementer with `implementer.md`, the phase section, branch, base SHA, run folder, verification
   commands and carried findings.
3. Spawn a fresh read-only reviewer with `reviewer.md`, the brief's acceptance criteria, phase section, range,
   checks, config rules, prior reports and carried findings.
4. On `NEEDS_CHANGES`, resume the same implementer to fix with new commits, then a new reviewer re-reviews.
5. Non-final phases: one initial review plus at most one fix/re-review cycle; remaining material findings carry
   forward.
6. Final phase: up to three review rounds. Anything still open goes in result.json as `open_findings`; the engine's
   PR review judges it. Do not loop further.
7. Save the final SHA, checks, verdict and carried findings in run config.

### Finish

Write `<run folder>/result.json`:

```json
{
  "branch": "arm/g3-abcd",
  "head": "<sha>",
  "title": "short plain title of the change",
  "summary": "the PR description: a few plain sentences on what changed for people and why. Shorter is better.",
  "phases": 2,
  "checks": "commands run and their final status",
  "open_findings": [],
  "assumptions": ["..."]
}
```

If the work turned out to be impossible or unsafe, still write result.json with `"head": null` and the reason in
`summary`.
