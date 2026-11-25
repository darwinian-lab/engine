# Address-feedback runbook (automated, no human)

Automated reviewers left findings on this mutant's PR. Address them on the checked-out top branch.

1. Triage every finding: `apply` (it is right), or `reject` with a concrete, evidence-backed reason (it is wrong,
   already handled, or out of scope). Never reject a blocking finding just to save work.
2. Fix the applied findings with new commits on top of the branch (any granularity; mention the finding ids in
   the messages). Add a regression test for behaviour bugs. Don't rewrite existing commits unless genuinely stuck.
3. Run `npm test`, `npm run typecheck`, `npm run e2e`, and check UI fixes in the browser at phone and laptop widths.
4. Never modify protected files, never push.

Answer with ONLY a JSON object:
{"dispositions": [{"id": "F1", "action": "apply" | "reject", "commit": "<sha or empty>", "reason": "..."}],
 "summary": "one paragraph"}
