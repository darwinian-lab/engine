# Darwinian engine

Software that evolves by natural selection. The engine is the "laws of physics": it measures, selects and
breeds. Species (separate repos) are the organisms. **Species evolve; the engine does not.**

```
                 visitor ──► router (Cloudflare Worker on the public domain)
                              │  sticky cookie, Thompson sampling, 10% frozen control
                              │  server-side fitness events → D1 "darwinian"
        ┌─────────────────────┼─────────────────────┐
   sp-qr-g0-ctrl        sp-qr-g3-k2f9          sp-qr-g4-x7aa      (each arm = its own Worker)
   (frozen control)     (champion)              (challenger)

 every 3h on the server:  evolve/run.mjs
   select   → promote (P(best) ≥ 0.95) / retire (P(best) < 0.05, or too old)
   breed    → Claude Code writes a mutation in a git worktree of the parent
   gates    → protected files untouched, tests + typecheck + build pass (one repair attempt)
   audit    → Codex checks the diff against CHARTER.md (fail-closed)
   personas → Codex compares parent vs child pages as 3 personas (rejects broken/clearly worse)
   deploy   → wrangler deploy sp-<species>-<arm>, register as live, push fossil tag
```

## Fitness
Each species' protected `species.json` declares fitness events as request patterns the router observes
(e.g. `GET /api/qr.svg?dl=1`), so mutants cannot report their own success. Fitness is **staged**:
activation → intent/engagement → revenue; a species advances when the current stage is routinely achieved.
A visitor is a trial once their browser runs JS (bots excluded); a success once they trigger the stage event.

## Guardrails
- CHARTER.md: no dark patterns, honest pricing, no measurement gaming, additive-only migrations, privacy.
- Protected files are enforced mechanically; the charter is enforced by an independent model (Codex).
- Router cron kills any arm with >5% server errors over 50+ requests in an hour (auto-rollback).
- Population size adapts to traffic so every arm can actually be judged.
- The frozen control arm (generation 0) answers the real question: does evolution beat standing still?

## Operating
- Owner dashboard: `https://<domain>/_dw/lab?key=<labKey>` (per species, read-only).
- Setup: `scripts/setup-server.sh` (once, as root), then `scripts/bootstrap.mjs`, then enable the timer.
- Manual run: `node evolve/run.mjs --config /etc/darwinian/config.json [--species qr] [--dry-run]`.
