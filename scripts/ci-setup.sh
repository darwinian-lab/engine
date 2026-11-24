#!/usr/bin/env bash
# Prepares a GitHub Actions runner for the engine: CLIs, logins, git credentials, species checkouts.
set -euo pipefail
: "${DW_GH_TOKEN:?DW_GH_TOKEN secret is missing}"
ORG=$(jq -r .github.org evolve/settings.json)
WORK=${DW_WORKDIR:-$GITHUB_WORKSPACE/../work}
mkdir -p "$WORK/.tmp"

npm install -g --silent @anthropic-ai/claude-code @openai/codex wrangler >/dev/null

# Codex login (ChatGPT subscription) comes from a secret; it is written back after the run.
if [ -n "${CODEX_AUTH_JSON:-}" ]; then
  mkdir -p ~/.codex && printf '%s' "$CODEX_AUTH_JSON" > ~/.codex/auth.json && chmod 600 ~/.codex/auth.json
  sha256sum ~/.codex/auth.json | cut -d' ' -f1 > "$WORK/.tmp/codex-auth.sha"
fi

git config --global user.name "darwinian"
git config --global user.email "evolve@darwinian.local"
git config --global url."https://x-access-token:${DW_GH_TOKEN}@github.com/".insteadOf "https://github.com/"

for repo in $(jq -r '.species[].repo' evolve/settings.json); do
  [ -d "$WORK/$repo" ] || git clone -q "https://github.com/$ORG/$repo.git" "$WORK/$repo"
done
echo "DW_WORKDIR=$WORK" >> "$GITHUB_ENV"
