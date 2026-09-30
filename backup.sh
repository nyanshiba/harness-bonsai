#!/bin/bash

if [ "$1" == "" ]; then
  server="opencode.igo"
else
  server=$@
fi

echo repos/skills/
rsync -rtvm --delete \
  --exclude='.git/' \
  --exclude='**/.git/' \
  \
  --exclude='.agents/skills/domain-modeling/' \
  --exclude='.agents/skills/grill-with-docs/' \
  --exclude='.agents/skills/grilling/' \
  --exclude='.agents/skills/dsh-trim-cot-leakage/' \
  --exclude='.agents/skills/show-me/' \
  --exclude='cloudflare/.agents/skills/agents-sdk/' \
  --exclude='cloudflare/.agents/skills/cloudflare/' \
  --exclude='cloudflare/.agents/skills/cloudflare-one/' \
  --exclude='cloudflare/.agents/skills/wrangler/' \
  --exclude='cloudflare/.agents/skills/modern-web-guidance/' \
  --exclude='grafana/.agents/skills/' \
  --exclude='llama/.agents/skills/' \
  \
  --include='***/' \
  --include='.agents/skills/***' \
  --include='**/.agents/skills/***' \
  --exclude='*' \
  "$server:/root/" "../skills/"

echo repos/opencode-bonsai/
rsync -rtvm \
  --exclude='node_modules/' \
  --include='***/' \
  --include='.config/opencode/***' \
  --include='health/opencode.json' \
  --include='llama/opencode.json' \
  --include='playwright/opencode.json' \
  --exclude='*' \
  "$server:/root/" "../opencode-bonsai/"

echo /etc/
rsync -rtv \
  --include='sysctl.d/***' \
  \
  --include='systemd/' \
  --include='systemd/network/' \
  --include='systemd/network/eth0.network.d/***' \
  \
  --exclude='*' \
  "$server:/etc/" "../opencode-bonsai/etc/"

echo repos/opencode/
rsync -rtv \
  --exclude='.*' \
  --exclude='opencode.json' \
  --exclude='go' \
  --exclude='node_modules/' \
  --exclude='plan/v380-web' \
  "$server:/root/" "../opencode/root/"

echo saving opencode.db
ssh -t $server "opencode2 api get /api/session/active" | grep -q '"type":"running"' && {
    echo "error: opencode2 is in use" >&2; exit 1;
}
ssh -t $server "opencode2 service stop; sleep 1"

rsync -rtv "$server:/root/.local/share/opencode/opencode.db" ../opencode/root/.local/share/opencode

ssh -t $server "opencode2 service start"
