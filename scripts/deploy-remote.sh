#!/usr/bin/env bash
# Deploys the hosted remote-access services (docs/13-remote-access.md) to the
# Uberspace host: the relay at wss://relay.endtime-instruments.org (a supervisord
# service behind a domain backend) and the web client at
# https://cmd.endtime-instruments.org (static files served by Apache). Both are
# the app's defaults; people who want more privacy run their own relay.
#
# Run by CI (.github/workflows/remote.yml) on master; works from a laptop with
# SSH access too. Idempotent: the first run also adds the domains, the service
# and the backend. A restart drops relay connections; Macs and phones reconnect.

set -euo pipefail

HOST="${UBERSPACE_HOST:-janoelze@aquila.uberspace.de}"
RELAY_DOMAIN="relay.endtime-instruments.org"
CLIENT_DOMAIN="cmd.endtime-instruments.org"
PORT=4010

cd "$(dirname "$0")/.."
pnpm --filter @cmd/relay build
pnpm --filter @cmd/web build

# The bundle must start before it replaces the running relay: a dependency esbuild
# can't follow (a UMD file's relative require) only fails when node loads it.
check_dir=$(mktemp -d)
check_port=$((20000 + RANDOM % 20000))
HOST=127.0.0.1 PORT=$check_port RELAY_STATE="$check_dir/routes.json" node apps/relay/dist/relay.mjs &
check_pid=$!
ok=""
for i in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:$check_port/health" >/dev/null 2>&1; then ok=1; break; fi
  kill -0 "$check_pid" 2>/dev/null || break
  sleep 0.5
done
kill "$check_pid" 2>/dev/null || true
rm -rf "$check_dir"
[ -n "$ok" ] || { echo "relay: the bundle doesn't start, not deploying" >&2; exit 1; }

ssh "$HOST" "mkdir -p ~/cmd-relay ~/cmd-relay-data /var/www/virtual/\$USER/$CLIENT_DOMAIN"
rsync -az apps/relay/dist/relay.mjs "$HOST:cmd-relay/relay.mjs"
rsync -az --delete apps/web/dist/ "$HOST:/var/www/virtual/janoelze/$CLIENT_DOMAIN/"

ssh "$HOST" bash -s <<REMOTE
set -euo pipefail
for d in $RELAY_DOMAIN $CLIENT_DOMAIN; do
  uberspace web domain list | grep -qx "\$d" || uberspace web domain add "\$d"
done
cat > ~/etc/services.d/cmd-relay.ini <<'INI'
[program:cmd-relay]
directory=%(ENV_HOME)s/cmd-relay
command=/opt/nodejs22/bin/node relay.mjs
autostart=true
autorestart=true
startsecs=2
environment=HOST="0.0.0.0",PORT="$PORT",RELAY_ORIGINS="https://$CLIENT_DOMAIN",RELAY_STATE="%(ENV_HOME)s/cmd-relay-data/routes.json",RELAY_TRUST_PROXY="1"
INI
supervisorctl reread >/dev/null
supervisorctl update >/dev/null
supervisorctl restart cmd-relay
uberspace web backend set "$RELAY_DOMAIN/" --http --port $PORT
REMOTE

# New domains get their certificate within a minute or so.
for i in $(seq 1 30); do
  if curl -fsS "https://$RELAY_DOMAIN/health"; then break; fi
  [ "$i" = 30 ] && { echo "relay: no health after 60 s" >&2; exit 1; }
  sleep 2
done
curl -fsS -o /dev/null "https://$CLIENT_DOMAIN/pair" && echo "client: ok"
