#!/usr/bin/env bash
# Darwinian server setup. Run once as root on a fresh Ubuntu 22.04/24.04 server:
#   curl -fsSL <raw url of this file> | sudo bash        (or copy it over and: sudo bash setup-server.sh)
# It asks for a few values interactively. Nothing secret is printed or logged.
set -euo pipefail

ORG_DEFAULT="darwinian-lab"
WORK=/opt/darwinian
ETC=/etc/darwinian
USER_NAME=darwin

say() { printf "\n\033[1;34m==> %s\033[0m\n" "$*"; }
ask() { local v; read -r -p "$1: " v </dev/tty; echo "$v"; }
ask_secret() { local v; read -r -s -p "$1: " v </dev/tty; echo >&2; echo "$v"; }

say "Installing system packages and Node.js 22"
apt-get update -qq
apt-get install -y -qq git curl ca-certificates build-essential jq >/dev/null
if ! command -v node >/dev/null || [[ "$(node -v)" != v22* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi

say "Installing Claude Code and Codex CLIs"
npm install -g --silent @anthropic-ai/claude-code @openai/codex

say "Creating the '$USER_NAME' user and folders"
id -u $USER_NAME >/dev/null 2>&1 || useradd -m -s /bin/bash $USER_NAME
mkdir -p $WORK $ETC
chown -R $USER_NAME:$USER_NAME $WORK
chmod 750 $ETC

ORG=$(ask "GitHub organization [$ORG_DEFAULT]"); ORG=${ORG:-$ORG_DEFAULT}
GH_TOKEN=$(ask_secret "GitHub fine-grained token (read/write to the org's repos)")
CF_ACCOUNT=$(ask "Cloudflare Account ID")
CF_TOKEN=$(ask_secret "Cloudflare API token")
DOMAIN_QR=$(ask "Domain for the QR product (e.g. keepqr.com)")
DOMAIN_RESUME=$(ask "Domain for the resume product")
DOMAIN_WALL=$(ask "Domain for the testimonial product")
CLAUDE_TOKEN=$(ask_secret "Claude Code token (run 'claude setup-token' on your laptop and paste the result)")

say "Cloning repositories"
sudo -u $USER_NAME git config --global credential.helper store
printf "https://x-access-token:%s@github.com\n" "$GH_TOKEN" | sudo -u $USER_NAME tee /home/$USER_NAME/.git-credentials >/dev/null
chmod 600 /home/$USER_NAME/.git-credentials
for r in engine species-qr species-resume species-wall; do
  [ -d $WORK/$r ] || sudo -u $USER_NAME git clone -q https://github.com/$ORG/$r.git $WORK/$r
done
sudo -u $USER_NAME bash -c "cd $WORK/engine && npm install --silent --no-audit --no-fund"

say "Writing config"
jq --arg acct "$CF_ACCOUNT" --arg tok "$CF_TOKEN" --arg org "$ORG" \
   --arg qr "$DOMAIN_QR" --arg rs "$DOMAIN_RESUME" --arg wl "$DOMAIN_WALL" '
  .cloudflare.accountId=$acct | .cloudflare.apiToken=$tok | .github.org=$org |
  (.species[] | select(.id=="qr")).domain=$qr |
  (.species[] | select(.id=="resume")).domain=$rs |
  (.species[] | select(.id=="wall")).domain=$wl' \
  $WORK/engine/evolve/config.example.json > $ETC/config.json
printf "CLAUDE_CODE_OAUTH_TOKEN=%s\n" "$CLAUDE_TOKEN" > $ETC/env
chown -R $USER_NAME:$USER_NAME $ETC
chmod 600 $ETC/config.json $ETC/env

say "Installing the evolution timer (every 3 hours)"
cat > /etc/systemd/system/darwinian-evolve.service <<EOF
[Unit]
Description=Darwinian evolution cycle
After=network-online.target

[Service]
Type=oneshot
User=$USER_NAME
WorkingDirectory=$WORK/engine
EnvironmentFile=$ETC/env
ExecStartPre=/usr/bin/git -C $WORK/engine pull -q --ff-only
ExecStart=/usr/bin/node evolve/run.mjs --config $ETC/config.json
TimeoutStartSec=6h
EOF
cat > /etc/systemd/system/darwinian-evolve.timer <<EOF
[Unit]
Description=Run Darwinian evolution every 3 hours

[Timer]
OnBootSec=10min
OnUnitActiveSec=3h
Persistent=true

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload

cat <<EOF

$(printf "\033[1;32m")Almost done.$(printf "\033[0m") Two last steps:

1) Log Codex in (uses your ChatGPT subscription):
     sudo -u $USER_NAME codex login --device-auth
   (If that flag isn't supported by your Codex version, run 'codex login' on your laptop
    and copy ~/.codex/auth.json to /home/$USER_NAME/.codex/auth.json on this server.)

2) Bring generation 0 to life and start evolution:
     sudo -u $USER_NAME bash -c 'cd $WORK/engine && node scripts/bootstrap.mjs --config $ETC/config.json'
     systemctl enable --now darwinian-evolve.timer

Logs: journalctl -u darwinian-evolve -f
EOF
