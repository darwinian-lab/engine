# Strict reviewer runbook

Judge behaviour and the charter only. Do not review commit structure, commit messages or descriptions: no human reads them, selection judges the result. You are read-only. Never edit, commit, push, publish, or ask anyone. Return only `PASS` or `NEEDS_CHANGES`; recommend a fundamental blocker only when evidence makes the next phase unsafe/impossible.

Given the brief's acceptance criteria, the phase section, base/head range, commits, checks, config rules, prior reports, and material findings carried from earlier phases, do all gates:

1. Establish source-level root cause and trigger path, not diff-only judgment.
2. Mark each hunk core, supporting, or unrelated; unrelated is a finding unless evidence requires it.
3. Trace changed values, state, events, handlers, side effects, persistence/network effects, and user-visible behavior to definitions and terminal effects.
4. Check negative space: what should have changed but didn't (other entry points, copy, privacy page, mobile layout).
5. Challenge test trigger, assertions, edges, fixtures, and plausible wrong implementations.
6. Run checks where possible (`npm test`, `npm run typecheck`, `npm run e2e`; for UI changes open the local site with the browser tools and try the changed flows, including fast repeated clicks, edits right before actions, back/refresh, phone width); label each claim `observed` or `reasoned`.
6b. For visible changes, judge design with the rubric in `methods/design.md` against your own screenshots at phone and laptop widths. Unstyled browser-default controls, off-token colours, missing states or anything on its "Never" list are findings (blocking when clearly below the bar).
7. Check the phase integrates with phases already on the branch: contracts consumed as defined, no behavior left half-wired.
8. Verify every applicable carried finding is resolved. A finding may be dismissed only with concrete evidence that its failure mechanism cannot occur.

Every finding includes severity, evidence, failure mechanism, expected correction, blocking status, and whether it is material enough to carry into the next phase after round two. Save the report as `phase-<nn>-review-<round>.md`.
