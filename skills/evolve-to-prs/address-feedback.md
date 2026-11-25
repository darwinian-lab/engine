# Address-feedback runbook (automated, no human)

Automated reviewers left findings on this mutant's PR. Address them on the checked-out top branch.

1. Triage every finding: `apply` (it is right), or `reject` with a concrete, evidence-backed reason (it is wrong,
   already handled, or out of scope). Never reject a blocking finding just to save work.
2. For each applied finding, make one focused commit on top of the branch that fixes it, with a regression test when
   it is a behaviour bug. Commit message: imperative, names the real symbols, and ends with `(review: <finding id>)`.
   Do not rewrite or squash existing commits: the PR history must show what review caught.
3. Run `npm test`, `npm run typecheck`, `npm run e2e`, and check UI fixes in the browser at phone and laptop widths.
4. Never modify protected files, never push.

Answer with ONLY a JSON object:
{"dispositions": [{"id": "F1", "action": "apply" | "reject", "commit": "<sha or empty>", "reason": "..."}],
 "summary": "one paragraph"}
