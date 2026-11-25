# Implement-phase method

You are implementing one phase of a larger plan. The phase is your bible.

1. **Read the phase and the commit rules.** Use the phase and plan path the caller names. Follow `methods/commit-rules.md` as guidance while you commit; it is not enforced.
2. **Reconcile with what's already done.** `git status` (must be clean outside the run folder — if not, stop and report). `git --no-pager log --oneline -30` to see what's landed; spot-check commits with `git --no-pager show <hash>` only when the log alone leaves the picture unclear.
3. **Confirm the starting point.** Before any commit, establish: which phase, which steps remain (if partially done), and which branch and base SHA the caller assigned.
4. **Work test-first per step.** Each step is one behavior: write its failing tests, then the code that turns them green.
5. **Implement step by step, committing as you go.** Follow the phase's step order. Commit whenever it is useful; messages just say what changed. Don't spend time reshaping history. Record the SHA at the end of every step — the codebase must be green there.
6. **When the phase is ambiguous, missing detail, or reality contradicts it,** use the best evidence-backed choice that preserves the phase's delivered behavior, and record the deviation. 
7. **Verify and hand off.** Run the phase's acceptance checks. Stop on red — diagnose, don't paper over. Conclude with a short summary of commits landed, step-end SHAs, checks run, and any deviations.

Never push, publish, or expand scope to other phases. Changes and fixes go in new commits on top; rewrite a commit only when genuinely stuck.
