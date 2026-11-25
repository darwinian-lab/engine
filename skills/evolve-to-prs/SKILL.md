---
name: evolve-to-prs
description: Autonomous adaptation of work-to-prs for the Darwinian engine. Take one mutation's work item through private two-agent planning, phased TDD implementation, strict per-phase review, diff-driven PR grouping and PR descriptions, with no human in the loop. Leaves local branches plus a result.json; the engine publishes and runs PR review.
metadata:
  version: "1.0.0"
  derived-from: "mohasarc/mo-skills work-to-prs 2.2.0"
---

# Evolve to PRs

Implement one mutation end to end. There is no human anywhere in this loop: never ask questions, never wait for
approval, make the best evidence-backed decision and record it. The engine that invoked you publishes branches,
opens PRs and runs PR review after you finish; you never push.

## Inputs (from the invoking prompt)

- Work item file (the hypothesis: what to build and why, acceptance criteria, backlog issue if any).
- Repository (the current directory, a clean worktree at the base SHA), base SHA, branch prefix (e.g. `arm/g3-abcd`).
- Run folder (absolute path) for all artifacts. Use it instead of `runs/` inside this skill.

## Config

`config.md` beside this file holds the rules. Read it first. Its Extra guidance passes verbatim to every agent.

## Agents

Spawn subagents with the Task tool, passing the role's runbook file path and the run folder. Roles: planner
(+ companion, spawned by the planner), implementer, reviewer, grouper. Each spawn is fresh; only the implementer is
resumed, and only for review fixes within its phase. If subagents are unavailable, play the roles sequentially and
record the lost isolation in result.json.

## Boundaries

- Run phases, reviews and grouping decisions sequentially.
- Never push, create PRs, merge, delete branches, stash, or discard work.
- The orchestrator reads only the brief, phased plan, run config, git status, completion notes, review verdicts and
  grouper returns. Anything that needs the diff goes to a subagent.
- Never modify protected files listed in `species.json` (`protected`).

## Workflow

### Preflight and planning

1. Read `config.md`, the work item, and the repository's `CLAUDE.md`, `CHARTER.md`, `BRIEF.md`, `LESSONS.md`.
2. Confirm a clean working tree; record base SHA in run config.
3. Spawn the planner with `planner.md`. It writes `brief.md`, `phased-plan.md`, `planning-dialogue.md` in the run
   folder and returns plan path, phase count and material assumptions.
4. Create `run-config.md` from `templates/run-config.md`.

Keep the plan proportionate: a small mutation is usually one or two phases. Do not invent scope beyond the work item.

### Branches and PR groups

Part branches are `<prefix>-part-<nn>`. The first part bases on the base SHA; every next part bases on the previous
part's head, forming a stack. While open a part has no slug; on `CUT` rename it `<prefix>-part-<nn>-<slug>`.

### Each phase

1. Record phase base.
2. Spawn a fresh implementer with `implementer.md`, the phase section, part branch, base SHA, artifact folder,
   verification commands and carried findings.
3. Spawn a fresh read-only reviewer with `reviewer.md`, the brief's acceptance criteria, phase section, range,
   commits, checks, config rules, prior reports and carried findings.
4. On `NEEDS_CHANGES`, resume the same implementer, then a new reviewer re-reviews. Corrections amend/rebase the
   relevant commits of this unpublished branch.
5. Non-final phases: one initial review plus at most one fix/re-review cycle; remaining material findings carry
   forward.
6. Final phase: up to four review rounds. If material findings remain after round four, stop and record them in
   result.json as `open_findings`; the engine's PR review will judge them. Do not loop further.
7. Save final SHA, step-end SHAs, checks, verdict and carried findings in run config.
8. Spawn a fresh grouper in `decide` mode (`grouper.md`); act on `STACK` / `CUT` / `CUT_AT <sha>` as in the
   original workflow. Verify any history rewrite left the tree unchanged.

### Closing a part

On `CUT`/`CUT_AT`: rename the branch with the slug, create the next part branch from the cut SHA, spawn a fresh
grouper in `describe` mode for the closed range. It writes `proposed-pr-description.md` from
`templates/pr-description.md` and returns title and path.

### Finish

Write `<run folder>/result.json`:

```json
{
  "parts": [
    {"branch": "...", "base": "<base sha or previous part branch>", "head": "<sha>", "title": "...",
     "description_file": "<absolute path>"}
  ],
  "summary": "one paragraph: what was built and why",
  "phases": <n>,
  "checks": "commands run and their final status",
  "open_findings": [],
  "assumptions": ["..."]
}
```

Parts are ordered bottom to top. The top part's head is what gets deployed and tested. If the work turned out to be
impossible or unsafe, still write result.json with `"parts": []` and the reason in `summary`.
