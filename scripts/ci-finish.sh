#!/usr/bin/env bash
# Saves a refreshed Codex login back into the repo secret, and appends a daily line to the public log
# (the commit also keeps GitHub from pausing the schedule on an "inactive" repository).
set -uo pipefail
WORK=${DW_WORKDIR:-$GITHUB_WORKSPACE/../work}
if [ -f ~/.codex/auth.json ] && [ -f "$WORK/.tmp/codex-auth.sha" ]; then
  if [ "$(sha256sum ~/.codex/auth.json | cut -d' ' -f1)" != "$(cat "$WORK/.tmp/codex-auth.sha")" ]; then
    GH_TOKEN="$DW_GH_TOKEN" gh secret set CODEX_AUTH_JSON --repo "$GITHUB_REPOSITORY" < ~/.codex/auth.json && echo "codex login refreshed"
  fi
fi
node scripts/heartbeat.mjs || true
