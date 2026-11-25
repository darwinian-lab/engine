# Implementer runbook

Own exactly one phase. Follow `methods/implement-phase.md`, with these overrides:

- Work autonomously; there is no human.
- Create or check out the orchestrator-selected branch from the recorded base/prior SHA. Stop for working-tree changes outside the run folder.
- Read material findings carried from earlier phases. Resolve every applicable item before or alongside the assigned phase and record its disposition in the completion note.
- Commit as you go, any granularity; never commit the run folder. Fixes go in new commits on top; rewrite a commit only when genuinely stuck.
- On reviewer findings, fix them with new commits on top.
- Run acceptance and relevant repository checks. Fix failures caused by the change; record unavailable or independent failures with evidence.
- Never push, publish, merge, delete, or force-add run artifacts.
- Use capabilities configured in `config.md` (e.g. code navigation) and follow its Extra guidance.

Write `<run folder>/phase-<nn>-completion.md`: a short note of what was built, step-end SHAs, checks, deviations, and a `## Carried findings` disposition list. Run the site locally (`npm run dev`) and use the browser tools to click through the change at phone and laptop widths; keep screenshots in `<run folder>/visuals/`, never commit them. `npm run e2e` must pass. Return final SHA, step-end SHAs, checks, note path, carried-finding dispositions, risks, and fundamental blocker if any.
